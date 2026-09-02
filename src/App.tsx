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

// Petición de parámetros pendiente: se muestra un modal para completar los
// placeholders {{param}} de una tarea antes de ejecutarla.
interface ParamRequest {
  service: Service;
  task: Task;
  label: string;
  params: string[];
  values: Record<string, string>;
}

const emptyServiceForm = {
  name: "",
  path: "",
  url: "http://localhost:3000",
  port: 3000,
  command: "pnpm run start:dev",
};

const emptyTaskForm = { name: "", command: "" };

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

  // Formulario lateral: nombre del proyecto + (solo al crear) los datos del
  // primer servicio, para no obligar a un paso extra en el caso más común.
  const [projectName, setProjectName] = useState("");
  const [initialService, setInitialService] = useState(emptyServiceForm);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);

  // Formulario inline para agregar/editar un servicio dentro de un proyecto.
  const [serviceFormFor, setServiceFormFor] = useState<string | null>(null);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [serviceForm, setServiceForm] = useState(emptyServiceForm);

  // Formulario inline para agregar una tarea a un servicio puntual.
  const [taskFormFor, setTaskFormFor] = useState<{ projId: string; serviceId: string } | null>(
    null,
  );
  const [taskForm, setTaskForm] = useState(emptyTaskForm);

  // Modal de parámetros pendiente de completar antes de ejecutar una tarea.
  const [paramRequest, setParamRequest] = useState<ParamRequest | null>(null);

  // Ids pendientes de confirmación de borrado. No usamos window.confirm
  // porque WKWebView (macOS) no implementa los diálogos JS nativos: la
  // llamada devuelve false al instante sin mostrar nada, y el borrado nunca
  // llega a ejecutarse. Con este estado mostramos una confirmación propia.
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmDeleteServiceId, setConfirmDeleteServiceId] = useState<string | null>(null);

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

  const resetProjectForm = () => {
    setProjectName("");
    setInitialService(emptyServiceForm);
    setEditingProjectId(null);
  };

  const addProject = () => {
    if (editingProjectId) {
      if (!projectName) return;
      setProjects((prev) =>
        prev.map((p) => (p.id === editingProjectId ? { ...p, name: projectName } : p)),
      );
      addLog(GENERAL, ` ✏️ Proyecto renombrado a "${projectName}".`);
    } else {
      if (!projectName || !initialService.path) return;
      const projectId = Date.now().toString();
      const service: Service = {
        ...initialService,
        name: initialService.name || "Principal",
        id: `${projectId}-svc`,
        tasks: [],
      };
      setProjects((prev) => [...prev, { id: projectId, name: projectName, services: [service] }]);
      addLog(GENERAL, ` ➕ Proyecto "${projectName}" agregado.`);
    }
    resetProjectForm();
  };

  const startEditProject = (proj: Project) => {
    setEditingProjectId(proj.id);
    setProjectName(proj.name);
  };

  const deleteProject = async (proj: Project) => {
    setConfirmDeleteProjectId(null);

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
    if (editingProjectId === proj.id) resetProjectForm();
    setLogsByTab((prev) => {
      const rest = { ...prev };
      for (const service of proj.services) delete rest[service.id];
      return rest;
    });
    if (proj.services.some((s) => s.id === activeTab)) setActiveTab(GENERAL);
    addLog(GENERAL, ` 🗑 Proyecto "${proj.name}" eliminado.`);
  };

  // --- Servicio (ruta/comando/puerto/URL + tareas) ---

  const openServiceForm = (projId: string) => {
    setServiceFormFor(projId);
    setEditingServiceId(null);
    setServiceForm(emptyServiceForm);
  };

  const closeServiceForm = () => {
    setServiceFormFor(null);
    setEditingServiceId(null);
    setServiceForm(emptyServiceForm);
  };

  const startEditService = (proj: Project, service: Service) => {
    setServiceFormFor(proj.id);
    setEditingServiceId(service.id);
    setServiceForm({
      name: service.name,
      path: service.path,
      url: service.url,
      port: service.port,
      command: service.command,
    });
  };

  const saveService = (proj: Project) => {
    if (!serviceForm.name || !serviceForm.path) return;
    if (editingServiceId) {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) =>
                  s.id === editingServiceId ? { ...s, ...serviceForm } : s,
                ),
              }
            : p,
        ),
      );
      addLog(GENERAL, ` ✏️ Servicio "${serviceForm.name}" actualizado en ${proj.name}.`);
    } else {
      const newService: Service = { ...serviceForm, id: Date.now().toString(), tasks: [] };
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id ? { ...p, services: [...p.services, newService] } : p,
        ),
      );
      addLog(GENERAL, ` ➕ Servicio "${newService.name}" agregado a ${proj.name}.`);
    }
    closeServiceForm();
  };

  const deleteService = async (proj: Project, service: Service) => {
    setConfirmDeleteServiceId(null);
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

  const openTaskForm = (projId: string, serviceId: string) => {
    setTaskFormFor({ projId, serviceId });
    setTaskForm(emptyTaskForm);
  };

  const closeTaskForm = () => {
    setTaskFormFor(null);
    setTaskForm(emptyTaskForm);
  };

  const saveTask = (proj: Project, service: Service) => {
    if (!taskForm.name || !taskForm.command) return;
    const newTask: Task = {
      id: Date.now().toString(),
      name: taskForm.name,
      command: taskForm.command,
    };
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
    closeTaskForm();
  };

  const deleteTask = (proj: Project, service: Service, task: Task) => {
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
    setParamRequest({
      service,
      task,
      label: `${proj.name} · ${service.name}`,
      params,
      values: Object.fromEntries(params.map((p) => [p, ""])),
    });
  };

  const submitParamRequest = () => {
    if (!paramRequest) return;
    const command = buildCommand(paramRequest.task.command, paramRequest.values);
    runTaskCommand(paramRequest.service, paramRequest.task, command);
    setParamRequest(null);
  };

  return (
    <div className="app-container">
      <div className="header-section">
        <h2>Panel de Proyectos Locales</h2>
      </div>

      <div className="row">
        {/* Formulario Lateral */}
        <div className="col-4">
          <div className="card">
            <div className="card-body">
              <input
                className="form-input"
                placeholder="Nombre del Proyecto"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />

              {!editingProjectId && (
                <>
                  <input
                    className="form-input"
                    placeholder="Nombre del servicio (ej: Front)"
                    value={initialService.name}
                    onChange={(e) =>
                      setInitialService({ ...initialService, name: e.target.value })
                    }
                  />
                  <input
                    className="form-input"
                    placeholder="Ruta local (/Users/...)"
                    value={initialService.path}
                    onChange={(e) =>
                      setInitialService({ ...initialService, path: e.target.value })
                    }
                  />
                  <input
                    className="form-input"
                    placeholder="Comando (ej: pnpm run start:dev)"
                    value={initialService.command}
                    onChange={(e) =>
                      setInitialService({ ...initialService, command: e.target.value })
                    }
                  />
                  <div className="form-row">
                    <input
                      className="form-input input-port"
                      type="number"
                      placeholder="Puerto"
                      value={initialService.port}
                      onChange={(e) =>
                        setInitialService({ ...initialService, port: Number(e.target.value) })
                      }
                    />
                    <input
                      className="form-input input-url"
                      placeholder="URL Local"
                      value={initialService.url}
                      onChange={(e) =>
                        setInitialService({ ...initialService, url: e.target.value })
                      }
                    />
                  </div>
                </>
              )}

              <div className="form-actions">
                <button className="btn btn-save" onClick={addProject}>
                  {editingProjectId ? "💾 Guardar Cambios" : "+ Guardar Proyecto"}
                </button>
                {editingProjectId && (
                  <button className="btn btn-cancel" onClick={resetProjectForm}>
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Lista de Proyectos */}
        <div className="col-8 projects-column">
          {projects.map((proj) => (
            <div key={proj.id} className="project-group">
              <div className="project-group-header">
                <span className="project-group-name">{proj.name}</span>
                <div className="project-group-actions">
                  <button className="btn btn-action btn-run" onClick={() => runAllServices(proj)}>
                    ▶ Iniciar todo
                  </button>
                  <button
                    className="btn btn-action btn-kill"
                    onClick={() => killAllServices(proj)}
                  >
                    🛑 Matar todo
                  </button>
                  <button
                    className="btn btn-action btn-edit"
                    onClick={() => startEditProject(proj)}
                  >
                    ✏️ Renombrar
                  </button>
                  {confirmDeleteProjectId === proj.id ? (
                    <>
                      <button
                        className="btn btn-action btn-delete"
                        onClick={() => deleteProject(proj)}
                      >
                        ✅ Confirmar
                      </button>
                      <button
                        className="btn btn-action"
                        onClick={() => setConfirmDeleteProjectId(null)}
                      >
                        ✖ Cancelar
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-action btn-delete"
                      onClick={() => setConfirmDeleteProjectId(proj.id)}
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>

              <div className="services-list">
                {proj.services.map((service) => (
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
                          onClick={() => startEditService(proj, service)}
                        >
                          ✏️ Editar
                        </button>
                        {confirmDeleteServiceId === service.id ? (
                          <>
                            <button
                              className="btn btn-action btn-delete"
                              onClick={() => deleteService(proj, service)}
                            >
                              ✅ Confirmar
                            </button>
                            <button
                              className="btn btn-action"
                              onClick={() => setConfirmDeleteServiceId(null)}
                            >
                              ✖ Cancelar
                            </button>
                          </>
                        ) : (
                          <button
                            className="btn btn-action btn-delete"
                            onClick={() => setConfirmDeleteServiceId(service.id)}
                          >
                            🗑
                          </button>
                        )}
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
                              onClick={() => deleteTask(proj, service, task)}
                              title="Eliminar tarea"
                            >
                              🗑
                            </button>
                          </div>
                        ))}
                        <button
                          className="btn btn-action btn-add-task"
                          onClick={() =>
                            taskFormFor?.serviceId === service.id
                              ? closeTaskForm()
                              : openTaskForm(proj.id, service.id)
                          }
                        >
                          + Tarea
                        </button>
                      </div>

                      {taskFormFor?.serviceId === service.id && (
                        <div className="task-form">
                          <input
                            className="form-input"
                            placeholder="Nombre (ej: Test)"
                            value={taskForm.name}
                            onChange={(e) =>
                              setTaskForm({ ...taskForm, name: e.target.value })
                            }
                          />
                          <input
                            className="form-input"
                            placeholder='Comando (ej: npm run test, o git commit -m "{{mensaje}}")'
                            value={taskForm.command}
                            onChange={(e) =>
                              setTaskForm({ ...taskForm, command: e.target.value })
                            }
                          />
                          <button className="btn btn-save" onClick={() => saveTask(proj, service)}>
                            Guardar
                          </button>
                          <button className="btn btn-cancel" onClick={closeTaskForm}>
                            Cancelar
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                <button
                  className="btn btn-action btn-add-service"
                  onClick={() =>
                    serviceFormFor === proj.id && !editingServiceId
                      ? closeServiceForm()
                      : openServiceForm(proj.id)
                  }
                >
                  + Servicio (ej: Back)
                </button>

                {serviceFormFor === proj.id && (
                  <div className="card service-form-card">
                    <div className="card-body">
                      <input
                        className="form-input"
                        placeholder="Nombre del servicio (ej: Back)"
                        value={serviceForm.name}
                        onChange={(e) =>
                          setServiceForm({ ...serviceForm, name: e.target.value })
                        }
                      />
                      <input
                        className="form-input"
                        placeholder="Ruta local (/Users/...)"
                        value={serviceForm.path}
                        onChange={(e) =>
                          setServiceForm({ ...serviceForm, path: e.target.value })
                        }
                      />
                      <input
                        className="form-input"
                        placeholder="Comando (ej: pnpm run start:dev)"
                        value={serviceForm.command}
                        onChange={(e) =>
                          setServiceForm({ ...serviceForm, command: e.target.value })
                        }
                      />
                      <div className="form-row">
                        <input
                          className="form-input input-port"
                          type="number"
                          placeholder="Puerto"
                          value={serviceForm.port}
                          onChange={(e) =>
                            setServiceForm({ ...serviceForm, port: Number(e.target.value) })
                          }
                        />
                        <input
                          className="form-input input-url"
                          placeholder="URL Local"
                          value={serviceForm.url}
                          onChange={(e) =>
                            setServiceForm({ ...serviceForm, url: e.target.value })
                          }
                        />
                      </div>
                      <div className="form-actions">
                        <button className="btn btn-save" onClick={() => saveService(proj)}>
                          {editingServiceId ? "💾 Guardar Cambios" : "+ Guardar Servicio"}
                        </button>
                        <button className="btn btn-cancel" onClick={closeServiceForm}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
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

      {/* Modal de parámetros: se muestra cuando la tarea a ejecutar tiene
          placeholders {{param}} pendientes de completar. No usamos
          window.prompt porque WKWebView (macOS) tampoco lo implementa de
          forma confiable, igual que window.confirm (ver comentario arriba). */}
      {paramRequest && (
        <div className="modal-overlay" onClick={() => setParamRequest(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h4>Parámetros para "{paramRequest.task.name}"</h4>
            <p className="modal-sub">{paramRequest.label}</p>
            {paramRequest.params.map((p, i) => (
              <input
                key={p}
                className="form-input"
                placeholder={p}
                value={paramRequest.values[p]}
                autoFocus={i === 0}
                onChange={(e) =>
                  setParamRequest((prev) =>
                    prev
                      ? { ...prev, values: { ...prev.values, [p]: e.target.value } }
                      : prev,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitParamRequest();
                  if (e.key === "Escape") setParamRequest(null);
                }}
              />
            ))}
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitParamRequest}>
                ▶ Ejecutar
              </button>
              <button
                className="btn btn-cancel"
                onClick={() => setParamRequest(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
