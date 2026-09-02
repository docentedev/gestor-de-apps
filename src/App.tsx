import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

export interface Task {
  id: string;
  name: string;
  command: string;
}

// Un servicio es la unidad ejecutable real: tiene ruta, comando, puerto,
// URL y sus propias tareas puntuales (ej: npm run test para ese servicio).
export interface Service {
  id: string;
  name: string;
  path: string;
  url: string;
  port: number;
  command: string;
  tasks: Task[];
}

// El proyecto es solo un contenedor organizativo (ej: "MiApp") que agrupa
// los servicios que la componen (ej: Front y Back).
export interface Project {
  id: string;
  name: string;
  services: Service[];
}

interface ProcessOutput {
  id: string;
  stream: "stdout" | "stderr" | "exit" | "error";
  line: string;
}

interface ServiceFields {
  name: string;
  path: string;
  url: string;
  port: number;
  command: string;
}

interface TaskFields {
  name: string;
  command: string;
}

// Todos los formularios y confirmaciones de la app viven en un único modal
// (uno a la vez), abierto siempre desde un botón. `kind` decide qué cuerpo
// se renderiza; cada variante lleva solo los datos que necesita.
type Modal =
  | { kind: "createProject"; name: string; service: ServiceFields }
  | { kind: "editProject"; proj: Project; name: string }
  | { kind: "createService"; proj: Project; fields: ServiceFields }
  | { kind: "editService"; proj: Project; service: Service; fields: ServiceFields }
  | { kind: "createTask"; proj: Project; service: Service; fields: TaskFields }
  | { kind: "confirmDeleteProject"; proj: Project }
  | { kind: "confirmDeleteService"; proj: Project; service: Service }
  | { kind: "confirmDeleteTask"; proj: Project; service: Service; task: Task }
  | {
      kind: "params";
      service: Service;
      task: Task;
      label: string;
      params: string[];
      values: Record<string, string>;
    };

const emptyServiceForm: ServiceFields = {
  name: "",
  path: "",
  url: "http://localhost:3000",
  port: 3000,
  command: "pnpm run start:dev",
};

const emptyTaskForm: TaskFields = { name: "", command: "" };

// Detecta placeholders {{param}} dentro de un comando de tarea.
function extractParams(command: string): string[] {
  const matches = [...command.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)];
  return Array.from(new Set(matches.map((m) => m[1])));
}

// Sustituye los placeholders por los valores ingresados, citándolos para
// que zsh los trate como un solo argumento aunque contengan espacios o
// comillas (ej: git commit -m "{{mensaje}}" -> git commit -m "Mensaje con 'algo'").
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildCommand(command: string, values: Record<string, string>): string {
  return command.replace(
    /\{\{\s*([^}]+?)\s*\}\}/g,
    (_match, name) => shellQuote(values[name] ?? ""),
  );
}

// Una terminal por servicio (clave = id de servicio) + "_general" para
// eventos que no pertenecen a un proceso (agregar/editar/eliminar proyectos,
// servicios o tareas).
const GENERAL = "_general";

export default function App() {
  const [projects, setProjects] = useState<Project[]>([
    {
      id: "1",
      name: "saas-deporte",
      services: [
        {
          id: "1-svc",
          name: "Principal",
          path: "/Users/claudio.viajando/src/personales/saas-deporte",
          url: "http://localhost:3000",
          port: 3000,
          command: "pnpm run start:dev",
          tasks: [],
        },
      ],
    },
  ]);

  const [loaded, setLoaded] = useState(false);

  // Único modal activo (o null si no hay ninguno abierto).
  const [modal, setModal] = useState<Modal | null>(null);

  // Proyectos con la vista completa desplegada (rutas, comandos, tareas,
  // edición). Por defecto todos arrancan en vista mínima para que la lista
  // ocupe menos espacio; se expande por proyecto según se necesite.
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());

  const toggleProjectExpanded = (projId: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projId)) next.delete(projId);
      else next.add(projId);
      return next;
    });
  };

  const [logsByTab, setLogsByTab] = useState<Record<string, string[]>>({});
  const [activeTab, setActiveTab] = useState<string>(GENERAL);

  const addLog = (tab: string, msg: string) => {
    setLogsByTab((prev) => ({
      ...prev,
      [tab]: [`[${new Date().toLocaleTimeString()}]${msg}`, ...(prev[tab] ?? [])],
    }));
  };

  useEffect(() => {
    const unlisten = listen<ProcessOutput>("project-log", (event) => {
      const { id, stream, line } = event.payload;
      const icon = stream === "stderr" ? "⚠️" : stream === "exit" ? "⏹" : "›";
      addLog(id, ` ${icon} ${line}`);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Carga la configuración guardada (projects.json) al iniciar la app.
  // Si no hay nada guardado (primera vez), se queda con el proyecto de ejemplo.
  useEffect(() => {
    invoke<Project[]>("load_projects")
      .then((saved) => {
        if (saved && saved.length > 0) setProjects(saved);
      })
      .catch((err) => addLog(GENERAL, `❌ Error al cargar configuración: ${err}`))
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persiste automáticamente cada cambio en la lista de proyectos.
  // El guard `loaded` evita pisar el archivo guardado con el seed inicial
  // antes de que termine de cargar.
  useEffect(() => {
    if (!loaded) return;
    invoke("save_projects", { projects }).catch((err) =>
      addLog(GENERAL, `❌ Error al guardar configuración: ${err}`),
    );
  }, [projects, loaded]);

  // --- Proyecto (contenedor) ---

  const openCreateProject = () =>
    setModal({ kind: "createProject", name: "", service: emptyServiceForm });

  const openEditProject = (proj: Project) =>
    setModal({ kind: "editProject", proj, name: proj.name });

  const submitProjectModal = () => {
    if (!modal) return;
    if (modal.kind === "createProject") {
      const { name, service: fields } = modal;
      if (!name || !fields.path) return;
      const projectId = Date.now().toString();
      const service: Service = {
        ...fields,
        name: fields.name || "Principal",
        id: `${projectId}-svc`,
        tasks: [],
      };
      setProjects((prev) => [...prev, { id: projectId, name, services: [service] }]);
      addLog(GENERAL, ` ➕ Proyecto "${name}" agregado.`);
      setModal(null);
    } else if (modal.kind === "editProject") {
      const { name, proj } = modal;
      if (!name) return;
      setProjects((prev) => prev.map((p) => (p.id === proj.id ? { ...p, name } : p)));
      addLog(GENERAL, ` ✏️ Proyecto renombrado a "${name}".`);
      setModal(null);
    }
  };

  const askDeleteProject = (proj: Project) => setModal({ kind: "confirmDeleteProject", proj });

  const confirmDeleteProject = async () => {
    if (!modal || modal.kind !== "confirmDeleteProject") return;
    const { proj } = modal;
    setModal(null);

    // Mata los procesos escuchando en los puertos de todos los servicios del
    // proyecto antes de quitarlo, para no dejar procesos huérfanos corriendo
    // en segundo plano una vez que el proyecto ya no es visible.
    for (const service of proj.services) {
      try {
        const res = await invoke<string>("kill_port", { port: service.port });
        addLog(GENERAL, ` 🛑 Puerto ${service.port}: ${res}`);
      } catch (err) {
        addLog(GENERAL, ` ❌ Error al liberar puerto ${service.port}: ${err}`);
      }
    }

    setProjects((prev) => prev.filter((p) => p.id !== proj.id));
    setLogsByTab((prev) => {
      const rest = { ...prev };
      for (const service of proj.services) delete rest[service.id];
      return rest;
    });
    if (proj.services.some((s) => s.id === activeTab)) setActiveTab(GENERAL);
    addLog(GENERAL, ` 🗑 Proyecto "${proj.name}" eliminado.`);
  };

  // --- Servicio (ruta/comando/puerto/URL + tareas) ---

  const openCreateService = (proj: Project) => {
    setModal({ kind: "createService", proj, fields: emptyServiceForm });
    // El "+ Servicio" solo tiene sentido en la vista completa, así que se
    // despliega el proyecto si estaba en vista mínima.
    setExpandedProjectIds((prev) => new Set(prev).add(proj.id));
  };

  const openEditService = (proj: Project, service: Service) => {
    setModal({
      kind: "editService",
      proj,
      service,
      fields: {
        name: service.name,
        path: service.path,
        url: service.url,
        port: service.port,
        command: service.command,
      },
    });
  };

  const submitServiceModal = () => {
    if (!modal) return;
    if (modal.kind === "createService") {
      const { proj, fields } = modal;
      if (!fields.name || !fields.path) return;
      const newService: Service = { ...fields, id: Date.now().toString(), tasks: [] };
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id ? { ...p, services: [...p.services, newService] } : p,
        ),
      );
      addLog(GENERAL, ` ➕ Servicio "${newService.name}" agregado a ${proj.name}.`);
      setModal(null);
    } else if (modal.kind === "editService") {
      const { proj, service, fields } = modal;
      if (!fields.name || !fields.path) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) => (s.id === service.id ? { ...s, ...fields } : s)),
              }
            : p,
        ),
      );
      addLog(GENERAL, ` ✏️ Servicio "${fields.name}" actualizado en ${proj.name}.`);
      setModal(null);
    }
  };

  const askDeleteService = (proj: Project, service: Service) =>
    setModal({ kind: "confirmDeleteService", proj, service });

  const confirmDeleteService = async () => {
    if (!modal || modal.kind !== "confirmDeleteService") return;
    const { proj, service } = modal;
    setModal(null);
    try {
      const res = await invoke<string>("kill_port", { port: service.port });
      addLog(GENERAL, ` 🛑 Puerto ${service.port}: ${res}`);
    } catch (err) {
      addLog(GENERAL, ` ❌ Error al liberar puerto ${service.port}: ${err}`);
    }
    setProjects((prev) =>
      prev.map((p) =>
        p.id === proj.id ? { ...p, services: p.services.filter((s) => s.id !== service.id) } : p,
      ),
    );
    setLogsByTab((prev) => {
      const { [service.id]: _discard, ...rest } = prev;
      return rest;
    });
    if (activeTab === service.id) setActiveTab(GENERAL);
    addLog(GENERAL, ` 🗑 Servicio "${service.name}" eliminado de ${proj.name}.`);
  };

  const runService = async (service: Service, opts: { switchTab?: boolean } = {}) => {
    const { switchTab = true } = opts;
    if (switchTab) setActiveTab(service.id);
    try {
      const res = await invoke<string>("run_project_command", {
        id: service.id,
        path: service.path,
        command: service.command,
      });
      addLog(service.id, `▶ ${res}`);
    } catch (err) {
      addLog(service.id, `❌ Error al iniciar: ${err}`);
    }
  };

  const killService = async (service: Service, opts: { switchTab?: boolean } = {}) => {
    const { switchTab = true } = opts;
    if (switchTab) setActiveTab(service.id);
    try {
      const res = await invoke<string>("kill_port", { port: service.port });
      addLog(service.id, `🛑 Puerto ${service.port}:${res}`);
    } catch (err) {
      addLog(service.id, `❌ Error al liberar puerto ${service.port}:${err}`);
    }
  };

  const openService = async (service: Service) => {
    try {
      await invoke("open_browser_url", { url: service.url });
      addLog(service.id, `🌐 Abriendo ${service.url}`);
    } catch (err) {
      addLog(service.id, `❌ Error al abrir URL: ${err}`);
    }
  };

  // Inicia/mata todos los servicios del proyecto de una sola vez (ej: levantar
  // front y back juntos). No cambiamos de pestaña por cada uno para no saltar
  // de una a otra; se deja la del primer servicio como referencia visual.
  const runAllServices = (proj: Project) => {
    if (proj.services.length === 0) return;
    setActiveTab(proj.services[0].id);
    proj.services.forEach((service) => runService(service, { switchTab: false }));
  };

  const killAllServices = (proj: Project) => {
    proj.services.forEach((service) => killService(service, { switchTab: false }));
  };

  // --- Tareas puntuales de un servicio ---

  const openCreateTask = (proj: Project, service: Service) =>
    setModal({ kind: "createTask", proj, service, fields: emptyTaskForm });

  const submitTaskModal = () => {
    if (!modal || modal.kind !== "createTask") return;
    const { proj, service, fields } = modal;
    if (!fields.name || !fields.command) return;
    const newTask: Task = { id: Date.now().toString(), name: fields.name, command: fields.command };
    setProjects((prev) =>
      prev.map((p) =>
        p.id === proj.id
          ? {
              ...p,
              services: p.services.map((s) =>
                s.id === service.id ? { ...s, tasks: [...s.tasks, newTask] } : s,
              ),
            }
          : p,
      ),
    );
    addLog(GENERAL, ` ➕ Tarea "${newTask.name}" agregada a ${proj.name} · ${service.name}.`);
    setModal(null);
  };

  const askDeleteTask = (proj: Project, service: Service, task: Task) =>
    setModal({ kind: "confirmDeleteTask", proj, service, task });

  const confirmDeleteTask = () => {
    if (!modal || modal.kind !== "confirmDeleteTask") return;
    const { proj, service, task } = modal;
    setModal(null);
    setProjects((prev) =>
      prev.map((p) =>
        p.id === proj.id
          ? {
              ...p,
              services: p.services.map((s) =>
                s.id === service.id ? { ...s, tasks: s.tasks.filter((t) => t.id !== task.id) } : s,
              ),
            }
          : p,
      ),
    );
    addLog(GENERAL, ` 🗑 Tarea "${task.name}" eliminada de ${proj.name} · ${service.name}.`);
  };

  // Corre el comando final (ya con los parámetros sustituidos) reusando el
  // mismo backend que el comando principal del servicio: transmite
  // stdout/stderr en vivo y avisa cuando el proceso termina (evento "exit"),
  // tal como pide el uso "npm run test" o similar que empieza y acaba solo.
  const runTaskCommand = async (service: Service, task: Task, command: string) => {
    setActiveTab(service.id);
    addLog(service.id, ` ▶ Tarea "${task.name}": ${command}`);
    try {
      const res = await invoke<string>("run_project_command", {
        id: service.id,
        path: service.path,
        command,
      });
      addLog(service.id, `▶ ${res}`);
    } catch (err) {
      addLog(service.id, `❌ Error al ejecutar tarea: ${err}`);
    }
  };

  const handleRunTask = (proj: Project, service: Service, task: Task) => {
    const params = extractParams(task.command);
    if (params.length === 0) {
      runTaskCommand(service, task, task.command);
      return;
    }
    // Comando con placeholders (ej: git commit -m "{{mensaje}}"): se pide
    // el valor de cada uno antes de ejecutar.
    setModal({
      kind: "params",
      service,
      task,
      label: `${proj.name} · ${service.name}`,
      params,
      values: Object.fromEntries(params.map((p) => [p, ""])),
    });
  };

  const submitParamsModal = () => {
    if (!modal || modal.kind !== "params") return;
    const { service, task, values } = modal;
    const command = buildCommand(task.command, values);
    setModal(null);
    runTaskCommand(service, task, command);
  };

  // Cuerpo del modal único: qué se muestra depende de `modal.kind`. Cada
  // input actualiza su propia rama del estado con la forma funcional de
  // setModal (vuelve a angostar el tipo dentro del updater), así no hace
  // falta depender de que el narrowing de TS atraviese los closures.
  const renderModalBody = () => {
    if (!modal) return null;

    switch (modal.kind) {
      case "createProject":
      case "editProject": {
        const isCreate = modal.kind === "createProject";
        return (
          <>
            <h4>{isCreate ? "Nuevo proyecto" : "Renombrar proyecto"}</h4>
            <input
              className="form-input"
              placeholder="Nombre del Proyecto"
              value={modal.name}
              autoFocus
              onChange={(e) =>
                setModal((prev) =>
                  prev && (prev.kind === "createProject" || prev.kind === "editProject")
                    ? { ...prev, name: e.target.value }
                    : prev,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") submitProjectModal();
                if (e.key === "Escape") setModal(null);
              }}
            />
            {modal.kind === "createProject" && (
              <>
                <input
                  className="form-input"
                  placeholder="Nombre del servicio (ej: Front)"
                  value={modal.service.name}
                  onChange={(e) =>
                    setModal((prev) =>
                      prev && prev.kind === "createProject"
                        ? { ...prev, service: { ...prev.service, name: e.target.value } }
                        : prev,
                    )
                  }
                />
                <input
                  className="form-input"
                  placeholder="Ruta local (/Users/...)"
                  value={modal.service.path}
                  onChange={(e) =>
                    setModal((prev) =>
                      prev && prev.kind === "createProject"
                        ? { ...prev, service: { ...prev.service, path: e.target.value } }
                        : prev,
                    )
                  }
                />
                <input
                  className="form-input"
                  placeholder="Comando (ej: pnpm run start:dev)"
                  value={modal.service.command}
                  onChange={(e) =>
                    setModal((prev) =>
                      prev && prev.kind === "createProject"
                        ? { ...prev, service: { ...prev.service, command: e.target.value } }
                        : prev,
                    )
                  }
                />
                <div className="form-row">
                  <input
                    className="form-input input-port"
                    type="number"
                    placeholder="Puerto"
                    value={modal.service.port}
                    onChange={(e) =>
                      setModal((prev) =>
                        prev && prev.kind === "createProject"
                          ? {
                              ...prev,
                              service: { ...prev.service, port: Number(e.target.value) },
                            }
                          : prev,
                      )
                    }
                  />
                  <input
                    className="form-input input-url"
                    placeholder="URL Local"
                    value={modal.service.url}
                    onChange={(e) =>
                      setModal((prev) =>
                        prev && prev.kind === "createProject"
                          ? { ...prev, service: { ...prev.service, url: e.target.value } }
                          : prev,
                      )
                    }
                  />
                </div>
              </>
            )}
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitProjectModal}>
                {isCreate ? "+ Guardar Proyecto" : "💾 Guardar Cambios"}
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );
      }

      case "createService":
      case "editService": {
        const isCreate = modal.kind === "createService";
        return (
          <>
            <h4>
              {modal.kind === "createService"
                ? `Nuevo servicio en "${modal.proj.name}"`
                : `Editar servicio "${modal.service.name}"`}
            </h4>
            <input
              className="form-input"
              placeholder="Nombre del servicio (ej: Back)"
              value={modal.fields.name}
              autoFocus
              onChange={(e) =>
                setModal((prev) =>
                  prev && (prev.kind === "createService" || prev.kind === "editService")
                    ? { ...prev, fields: { ...prev.fields, name: e.target.value } }
                    : prev,
                )
              }
            />
            <input
              className="form-input"
              placeholder="Ruta local (/Users/...)"
              value={modal.fields.path}
              onChange={(e) =>
                setModal((prev) =>
                  prev && (prev.kind === "createService" || prev.kind === "editService")
                    ? { ...prev, fields: { ...prev.fields, path: e.target.value } }
                    : prev,
                )
              }
            />
            <input
              className="form-input"
              placeholder="Comando (ej: pnpm run start:dev)"
              value={modal.fields.command}
              onChange={(e) =>
                setModal((prev) =>
                  prev && (prev.kind === "createService" || prev.kind === "editService")
                    ? { ...prev, fields: { ...prev.fields, command: e.target.value } }
                    : prev,
                )
              }
            />
            <div className="form-row">
              <input
                className="form-input input-port"
                type="number"
                placeholder="Puerto"
                value={modal.fields.port}
                onChange={(e) =>
                  setModal((prev) =>
                    prev && (prev.kind === "createService" || prev.kind === "editService")
                      ? { ...prev, fields: { ...prev.fields, port: Number(e.target.value) } }
                      : prev,
                  )
                }
              />
              <input
                className="form-input input-url"
                placeholder="URL Local"
                value={modal.fields.url}
                onChange={(e) =>
                  setModal((prev) =>
                    prev && (prev.kind === "createService" || prev.kind === "editService")
                      ? { ...prev, fields: { ...prev.fields, url: e.target.value } }
                      : prev,
                  )
                }
              />
            </div>
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitServiceModal}>
                {isCreate ? "+ Guardar Servicio" : "💾 Guardar Cambios"}
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );
      }

      case "createTask":
        return (
          <>
            <h4>
              Nueva tarea en "{modal.proj.name} · {modal.service.name}"
            </h4>
            <input
              className="form-input"
              placeholder="Nombre (ej: Test)"
              value={modal.fields.name}
              autoFocus
              onChange={(e) =>
                setModal((prev) =>
                  prev && prev.kind === "createTask"
                    ? { ...prev, fields: { ...prev.fields, name: e.target.value } }
                    : prev,
                )
              }
            />
            <input
              className="form-input"
              placeholder='Comando (ej: npm run test, o git commit -m "{{mensaje}}")'
              value={modal.fields.command}
              onChange={(e) =>
                setModal((prev) =>
                  prev && prev.kind === "createTask"
                    ? { ...prev, fields: { ...prev.fields, command: e.target.value } }
                    : prev,
                )
              }
            />
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitTaskModal}>
                Guardar
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );

      case "confirmDeleteProject":
        return (
          <>
            <h4>¿Eliminar proyecto "{modal.proj.name}"?</h4>
            <p className="modal-sub">
              Se liberarán los puertos de sus {modal.proj.services.length} servicio(s) y se
              perderán sus tareas.
            </p>
            <div className="form-actions">
              <button className="btn btn-confirm-delete" onClick={confirmDeleteProject}>
                🗑 Eliminar
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );

      case "confirmDeleteService":
        return (
          <>
            <h4>¿Eliminar servicio "{modal.service.name}"?</h4>
            <p className="modal-sub">
              Se liberará el puerto {modal.service.port} y se perderán sus tareas.
            </p>
            <div className="form-actions">
              <button className="btn btn-confirm-delete" onClick={confirmDeleteService}>
                🗑 Eliminar
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );

      case "confirmDeleteTask":
        return (
          <>
            <h4>¿Eliminar tarea "{modal.task.name}"?</h4>
            <div className="form-actions">
              <button className="btn btn-confirm-delete" onClick={confirmDeleteTask}>
                🗑 Eliminar
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );

      case "params":
        return (
          <>
            <h4>Parámetros para "{modal.task.name}"</h4>
            <p className="modal-sub">{modal.label}</p>
            {modal.params.map((p, i) => (
              <input
                key={p}
                className="form-input"
                placeholder={p}
                value={modal.values[p]}
                autoFocus={i === 0}
                onChange={(e) =>
                  setModal((prev) =>
                    prev && prev.kind === "params"
                      ? { ...prev, values: { ...prev.values, [p]: e.target.value } }
                      : prev,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitParamsModal();
                  if (e.key === "Escape") setModal(null);
                }}
              />
            ))}
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitParamsModal}>
                ▶ Ejecutar
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <div className="app-container">
      <div className="header-section">
        <h2>Panel de Proyectos Locales</h2>
        <button className="btn btn-save" onClick={openCreateProject}>
          + Nuevo Proyecto
        </button>
      </div>

      {/* Lista de Proyectos */}
      <div className="projects-column">
        {projects.map((proj) => (
          <div key={proj.id} className="project-group">
            <div className="project-group-header">
              <span className="project-group-name">{proj.name}</span>
              <div className="project-group-actions">
                <button
                  className="btn btn-action btn-view-toggle"
                  onClick={() => toggleProjectExpanded(proj.id)}
                >
                  {expandedProjectIds.has(proj.id) ? "▾ Vista mínima" : "▸ Vista completa"}
                </button>
                <button className="btn btn-action btn-run" onClick={() => runAllServices(proj)}>
                  ▶ Iniciar todo
                </button>
                <button className="btn btn-action btn-kill" onClick={() => killAllServices(proj)}>
                  🛑 Matar todo
                </button>
                <button className="btn btn-action btn-edit" onClick={() => openEditProject(proj)}>
                  ✏️ Renombrar
                </button>
                <button
                  className="btn btn-action btn-delete"
                  onClick={() => askDeleteProject(proj)}
                >
                  🗑
                </button>
              </div>
            </div>

            <div className="services-list">
              {!expandedProjectIds.has(proj.id) && (
                // Vista mínima: solo chips compactos por servicio (nombre,
                // puerto, iniciar/matar). Sin rutas, comandos ni tareas.
                <div className="services-mini-row">
                  {proj.services.map((service) => (
                    <div
                      key={service.id}
                      className="service-chip-mini"
                      onClick={() => setActiveTab(service.id)}
                      title={`${service.path} • ${service.command}`}
                    >
                      <span className="service-chip-name">{service.name}</span>
                      <span className="service-chip-port">:{service.port}</span>
                      <button
                        className="btn btn-action btn-run"
                        onClick={(e) => {
                          e.stopPropagation();
                          runService(service);
                        }}
                        title="Iniciar"
                      >
                        ▶
                      </button>
                      <button
                        className="btn btn-action btn-kill"
                        onClick={(e) => {
                          e.stopPropagation();
                          killService(service);
                        }}
                        title="Matar puerto"
                      >
                        🛑
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {expandedProjectIds.has(proj.id) &&
                proj.services.map((service) => (
                  <div key={service.id} className="project-card">
                    <div className="project-main">
                      <div className="project-info">
                        <span className="project-name">{service.name}</span>
                        <span className="project-path">{service.path}</span>
                        <div className="project-details">
                          <code>{service.command}</code> • Puerto:{" "}
                          <strong>{service.port}</strong>
                        </div>
                      </div>

                      <div className="project-actions">
                        <button
                          className="btn btn-action btn-run"
                          onClick={() => runService(service)}
                        >
                          ▶ Iniciar
                        </button>
                        <button
                          className="btn btn-action btn-kill"
                          onClick={() => killService(service)}
                        >
                          🛑 Matar {service.port}
                        </button>
                        <button
                          className="btn btn-action btn-open"
                          onClick={() => openService(service)}
                        >
                          🌐 Abrir
                        </button>
                        <button
                          className="btn btn-action"
                          onClick={() => setActiveTab(service.id)}
                        >
                          🖥️ Terminal
                        </button>
                        <button
                          className="btn btn-action btn-edit"
                          onClick={() => openEditService(proj, service)}
                        >
                          ✏️ Editar
                        </button>
                        <button
                          className="btn btn-action btn-delete"
                          onClick={() => askDeleteService(proj, service)}
                        >
                          🗑
                        </button>
                      </div>
                    </div>

                    {/* Tareas puntuales del servicio: comandos que inician y
                        terminan solos (ej: npm run test, git commit -m
                        "{{mensaje}}"). Si el comando trae placeholders
                        {{param}}, al ejecutar se pide el valor antes de
                        correrlo. */}
                    <div className="project-tasks">
                      <div className="task-list">
                        {service.tasks.map((task) => (
                          <div key={task.id} className="task-chip">
                            <span className="task-name">{task.name}</span>
                            <code className="task-command" title={task.command}>
                              {task.command}
                            </code>
                            <button
                              className="btn btn-action btn-run"
                              onClick={() => handleRunTask(proj, service, task)}
                              title="Ejecutar tarea"
                            >
                              ▶
                            </button>
                            <button
                              className="btn btn-action btn-delete"
                              onClick={() => askDeleteTask(proj, service, task)}
                              title="Eliminar tarea"
                            >
                              🗑
                            </button>
                          </div>
                        ))}
                        <button
                          className="btn btn-action btn-add-task"
                          onClick={() => openCreateTask(proj, service)}
                        >
                          + Tarea
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

              {expandedProjectIds.has(proj.id) && (
                <button
                  className="btn btn-action btn-add-service"
                  onClick={() => openCreateService(proj)}
                >
                  + Servicio (ej: Back)
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Terminales por servicio */}
      <div className="console-section">
        <h4>Terminales</h4>
        <div className="terminal-tabs">
          <button
            className={`terminal-tab ${activeTab === GENERAL ? "active" : ""}`}
            onClick={() => setActiveTab(GENERAL)}
          >
            General
          </button>
          {projects.flatMap((proj) =>
            proj.services.map((service) => (
              <button
                key={service.id}
                className={`terminal-tab ${activeTab === service.id ? "active" : ""}`}
                onClick={() => setActiveTab(service.id)}
              >
                {proj.name} · {service.name}
              </button>
            )),
          )}
        </div>
        <div className="console-box">
          {(logsByTab[activeTab] ?? []).length === 0 ? (
            <span className="console-placeholder">
              Sin actividad en esta terminal todavía...
            </span>
          ) : (
            (logsByTab[activeTab] ?? []).map((log, i) => <div key={i}>{log}</div>)
          )}
        </div>
      </div>

      {/* Modal único: agrupa formularios de creación/edición y
          confirmaciones de cambios/eliminación. No usamos window.prompt ni
          window.confirm porque WKWebView (macOS) no los implementa de forma
          confiable: la llamada devuelve un valor por defecto al instante sin
          mostrar nada, así que el flujo nunca llega a completarse. */}
      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            {renderModalBody()}
          </div>
        </div>
      )}
    </div>
  );
}
