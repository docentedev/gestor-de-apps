import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  IconAlertTriangle,
  IconCheckCircle,
  IconChevronDown,
  IconChevronRight,
  IconCpu,
  IconDot,
  IconFolder,
  IconPencil,
  IconPlay,
  IconPlus,
  IconStop,
  IconStopCircle,
  IconTrash,
  IconXCircle,
} from "./icons";
import "./App.css";
import type { EnvVar, Task, TaskGroup, Service, Project } from "./types";
import BtnAddService from "./components/btn-add-service";
import ServiceChipMini from "./components/service-chip-mini";
import ServiceCard from "./components/service-card";
import SidebarItem from "./components/sidebar-item";

export type { EnvVar, Task, TaskGroup, Service, Project };

interface ProcessOutput {
  id: string;
  stream: "stdout" | "stderr" | "exit" | "error";
  line: string;
  code?: number | null;
}

// Resultado de chequear una herramienta del entorno local (Java, Rust, Go,
// Node, nvm). `version` es la primera línea de salida del comando de
// versión tal cual la imprime la herramienta, sin parsear más allá de eso.
interface EnvToolStatus {
  name: string;
  installed: boolean;
  version: string | null;
}

interface ServiceFields {
  name: string;
  path: string;
  url: string;
  port: number;
  command: string;
  env: EnvVar[];
}

interface TaskFields {
  name: string;
  command: string;
  env: EnvVar[];
}

interface TaskGroupFields {
  name: string;
  taskIds: string[];
}

// Todos los formularios de la app viven en un único modal (uno a la vez),
// abierto siempre desde un botón. `kind` decide qué cuerpo se renderiza;
// cada variante lleva solo los datos que necesita. Las confirmaciones de
// borrado NO viven aquí: usan `ask()` de @tauri-apps/plugin-dialog, que
// muestra una alerta nativa real del sistema (NSAlert en macOS) en vez de
// un modal dibujado en la página.
type Modal =
  | { kind: "createProject"; name: string; service: ServiceFields }
  | { kind: "editProject"; proj: Project; name: string }
  | { kind: "createService"; proj: Project; fields: ServiceFields }
  | {
      kind: "editService";
      proj: Project;
      service: Service;
      fields: ServiceFields;
    }
  | { kind: "createTask"; proj: Project; service: Service; fields: TaskFields }
  | {
      kind: "editTask";
      proj: Project;
      service: Service;
      task: Task;
      fields: TaskFields;
    }
  | {
      kind: "createTaskGroup";
      proj: Project;
      service: Service;
      fields: TaskGroupFields;
    }
  | {
      kind: "editTaskGroup";
      proj: Project;
      service: Service;
      group: TaskGroup;
      fields: TaskGroupFields;
    }
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
  env: [],
};

const emptyTaskForm: TaskFields = { name: "", command: "", env: [] };
const emptyTaskGroupForm: TaskGroupFields = { name: "", taskIds: [] };

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
  return command.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, name) =>
    shellQuote(values[name] ?? ""),
  );
}

// Antepone `export CLAVE='valor';` por cada variable con clave no vacía.
// Las del servicio van primero y las de la tarea después, así una tarea
// puede pisar una variable del servicio si define la misma clave.
function withEnv(command: string, ...envLists: EnvVar[][]): string {
  const exports = envLists
    .flat()
    .filter((e) => e.key.trim())
    .map((e) => `export ${e.key.trim()}=${shellQuote(e.value)};`)
    .join(" ");
  return exports ? `${exports} ${command}` : command;
}

// Una terminal por servicio (clave = id de servicio) + "_general" para
// eventos que no pertenecen a un proceso (agregar/editar/eliminar proyectos,
// servicios o tareas).
const GENERAL = "_general";

// Tipo de cada línea de log: decide qué icono y color usa en la terminal.
// "stdout" no lleva icono (es la salida normal del proceso, sin marcar).
type LogKind = "stdout" | "stderr" | "exit" | "error" | "success" | "action";

interface LogEntry {
  time: string;
  kind: LogKind;
  text: string;
}

function LogIcon({ kind }: { kind: LogKind }) {
  switch (kind) {
    case "stderr":
      return <IconAlertTriangle className="log-icon log-icon-warn" />;
    case "exit":
      return <IconStopCircle className="log-icon log-icon-muted" />;
    case "error":
      return <IconXCircle className="log-icon log-icon-error" />;
    case "success":
      return <IconCheckCircle className="log-icon log-icon-success" />;
    case "action":
      return <IconDot className="log-icon log-icon-action" size={8} />;
    default:
      return <span className="log-icon-spacer" />;
  }
}

// Editor de variables de entorno (clave=valor), reutilizado en el
// formulario de servicio y el de tarea. Se guarda como lista (no como
// objeto) para poder tener una fila con la clave a medio escribir sin
// pisar otra.
function EnvEditor({
  env,
  onChange,
}: {
  env: EnvVar[];
  onChange: (env: EnvVar[]) => void;
}) {
  return (
    <div className="env-editor">
      {env.map((row, i) => (
        <div key={i} className="env-row">
          <input
            className="form-input"
            placeholder="CLAVE"
            value={row.key}
            onChange={(e) => {
              const next = [...env];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
          />
          <input
            className="form-input"
            placeholder="valor"
            value={row.value}
            onChange={(e) => {
              const next = [...env];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
          />
          <button
            className="btn btn-action btn-delete btn-icon-only"
            onClick={() => onChange(env.filter((_, idx) => idx !== i))}
            title="Quitar variable"
          >
            <IconTrash size={11} />
          </button>
        </div>
      ))}
      <button
        className="btn btn-action btn-add-task"
        onClick={() => onChange([...env, { key: "", value: "" }])}
      >
        <IconPlus size={11} /> Variable de entorno
      </button>
    </div>
  );
}

// Nombres fijos de las herramientas que se chequean (deben coincidir con
// check_environment en Rust). Sirven para pintar las cards en estado
// "consultando" apenas se entra a la vista, antes de tener una respuesta.
const ENV_TOOL_NAMES = ["Java", "Kotlin", "Rust", "Go", "Node", "nvm"];

// Vista de "Entorno": una card por herramienta con su estado y versión.
// Los datos los maneja App (se piden cada vez que se entra a esta vista,
// no solo al abrir la app), este componente solo los pinta. La navegación
// nunca espera a la consulta: se entra de una y las cards arrancan en
// "consultando" hasta que llega la primera respuesta; en refrescos
// posteriores se mantienen los últimos valores visibles en vez de vaciarse.
function EnvironmentView({
  status,
  loading,
  onRefresh,
}: {
  status: EnvToolStatus[] | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const isFirstLoad = status === null;
  const items: EnvToolStatus[] =
    status ??
    ENV_TOOL_NAMES.map((name) => ({ name, installed: false, version: null }));

  return (
    <div className="environment-view">
      <div className="environment-header">
        <h2>Entorno local</h2>
        <button
          className="btn btn-action"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Consultando…" : "Actualizar"}
        </button>
      </div>
      <p className="modal-sub environment-hint">
        Se vuelve a consultar cada vez que entrás a esta vista.
      </p>
      <div
        className={`environment-grid ${loading && !isFirstLoad ? "is-refreshing" : ""}`}
      >
        {items.map((tool) => (
          <div
            key={tool.name}
            className={`environment-card ${tool.installed ? "installed" : ""} ${
              isFirstLoad ? "is-loading" : ""
            }`}
          >
            {isFirstLoad ? (
              <span className="environment-status-icon environment-status-loading" />
            ) : tool.installed ? (
              <IconCheckCircle
                className="environment-status-icon environment-status-ok"
                size={18}
              />
            ) : (
              <IconXCircle
                className="environment-status-icon environment-status-missing"
                size={18}
              />
            )}
            <div className="environment-card-body">
              <span className="environment-tool-name">{tool.name}</span>
              <span className="environment-tool-version">
                {isFirstLoad
                  ? "Consultando…"
                  : tool.installed
                    ? tool.version
                    : "No instalado"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

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
          env: [],
          taskGroups: [],
        },
      ],
    },
  ]);

  // Espejo de `projects` en un ref, para leer la lista más fresca de
  // servicios/puertos desde el handler de cierre de ventana sin tener que
  // volver a suscribirlo cada vez que cambian los proyectos.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const [loaded, setLoaded] = useState(false);

  // Único modal activo (o null si no hay ninguno abierto).
  const [modal, setModal] = useState<Modal | null>(null);

  // Proyectos con la vista completa desplegada (rutas, comandos, tareas,
  // edición). Por defecto todos arrancan en vista mínima para que la lista
  // ocupe menos espacio; se expande por proyecto según se necesite.
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    new Set(),
  );

  const toggleProjectExpanded = (projId: string) => {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projId)) next.delete(projId);
      else next.add(projId);
      return next;
    });
  };

  // Sección visible en el menú vertical: la lista de proyectos (con sus
  // servicios/tareas/terminal) o el chequeo del entorno local.
  const [activeView, setActiveView] = useState<"projects" | "environment">(
    "projects",
  );
  const [environmentStatus, setEnvironmentStatus] = useState<
    EnvToolStatus[] | null
  >(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);

  const checkEnvironment = () => {
    setEnvironmentLoading(true);
    invoke<EnvToolStatus[]>("check_environment")
      .then(setEnvironmentStatus)
      .catch((err) =>
        addLog(GENERAL, "error", `Error al chequear el entorno: ${err}`),
      )
      .finally(() => setEnvironmentLoading(false));
  };

  // Se re-consulta cada vez que se entra a la vista de Entorno (no solo al
  // abrir la app), para detectar algo que se instaló recién sin tener que
  // reiniciar.
  useEffect(() => {
    if (activeView === "environment") checkEnvironment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView]);

  const [logsByTab, setLogsByTab] = useState<Record<string, LogEntry[]>>({});
  const [activeTab, setActiveTab] = useState<string>(GENERAL);

  // Colapsa la terminal entera (pestañas + salida) a solo su título, para
  // poder achicar la ventana más de lo que el min-height del console-box
  // permitiría con la terminal desplegada.
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const consoleBoxRef = useRef<HTMLDivElement>(null);
  // Si el usuario ya estaba pegado al final del scroll cuando llega una
  // línea nueva, lo seguimos empujando hacia abajo; si se corrió para
  // arriba a leer algo viejo, no lo interrumpimos. Al cambiar de pestaña
  // sí forzamos ir al final (mostrar lo más reciente es lo esperado ahí).
  const stickToBottomRef = useRef(true);
  const prevActiveTabRef = useRef(activeTab);

  // Cada corrida de run_project_command usa un "id de proceso" propio para
  // que el backend pueda rastrear su PID sin pisar el de otra corrida (ej:
  // una tarea corriendo a la vez que el servidor del propio servicio). Este
  // mapa traduce ese id de proceso a la pestaña de terminal donde debe
  // aparecer su salida (siempre la del servicio, id de proceso o no).
  const procTabRef = useRef<Record<string, string>>({});

  // Tareas actualmente en ejecución: task.id -> id de proceso (para poder
  // matarlas por PID).
  const [runningTasks, setRunningTasks] = useState<Record<string, string>>({});
  const runningTasksRef = useRef(runningTasks);
  runningTasksRef.current = runningTasks;

  // Último estado conocido de "¿este servicio sigue corriendo?", para el
  // punto de corriendo/detenido. OJO: la clave de verdad es el PID que esta
  // app registró al lanzarlo (mismo id que usa run_project_command), NUNCA
  // el puerto — dos servicios de proyectos distintos pueden declarar el
  // mismo número de puerto sin estar corriendo los dos a la vez, y
  // chequear por puerto los mostraba erróneamente a ambos como activos. Se
  // marca en true al iniciar con éxito y en false cuando llega el evento
  // "exit"/"error" de ESE id puntual (ver el listener de "project-log").
  const [runningServices, setRunningServices] = useState<
    Record<string, boolean>
  >({});
  const runningServicesRef = useRef(runningServices);
  runningServicesRef.current = runningServices;

  // Nombre de la tarea (para el texto de la notificación) por id de
  // proceso, poblado al lanzarla y leído cuando llega su evento "exit".
  const taskNameByProcRef = useRef<Record<string, string>>({});

  // Resolvers pendientes por id de proceso, para que quien arrancó una
  // tarea (los grupos de tareas, en particular) pueda esperar su código de
  // salida sin tener que meter lógica de espera dentro del listener global.
  const pendingExitResolvers = useRef<
    Record<string, (code: number | null) => void>
  >({});

  const addLog = (tab: string, kind: LogKind, text: string) => {
    setLogsByTab((prev) => ({
      ...prev,
      [tab]: [
        ...(prev[tab] ?? []),
        { time: new Date().toLocaleTimeString(), kind, text },
      ],
    }));
  };

  const handleConsoleScroll = () => {
    const el = consoleBoxRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 24;
  };

  // Autoscroll: al cambiar de pestaña siempre vamos al final; dentro de la
  // misma pestaña, solo si el usuario ya estaba ahí (ver stickToBottomRef).
  useEffect(() => {
    const el = consoleBoxRef.current;
    if (!el) return;
    const tabChanged = prevActiveTabRef.current !== activeTab;
    prevActiveTabRef.current = activeTab;
    if (tabChanged) stickToBottomRef.current = true;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logsByTab, activeTab]);

  // Notificación nativa del sistema al terminar una tarea (no un servicio:
  // esos corren indefinidamente por diseño, un "exit" ahí no es una noticia
  // que amerite avisar). Útil para tareas largas cuando la ventana no tiene
  // foco. El permiso se pide una sola vez al montar la app.
  useEffect(() => {
    isPermissionGranted().then((granted) => {
      if (!granted) requestPermission();
    });
  }, []);

  const notifyTaskFinished = async (procId: string) => {
    const taskName = taskNameByProcRef.current[procId];
    if (!taskName) return;
    delete taskNameByProcRef.current[procId];
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) {
        sendNotification({
          title: "Tarea finalizada",
          body: `"${taskName}" terminó de correr.`,
        });
      }
    } catch {
      // Sin notificación no es crítico; la terminal ya muestra el resultado.
    }
  };

  useEffect(() => {
    const unlisten = listen<ProcessOutput>("project-log", (event) => {
      const { id, stream, line, code } = event.payload;
      const tab = procTabRef.current[id] ?? id;
      const kind: LogKind =
        stream === "stderr"
          ? "stderr"
          : stream === "exit"
            ? "exit"
            : stream === "error"
              ? "error"
              : "stdout";
      addLog(tab, kind, line);

      if (stream === "exit" || stream === "error") {
        delete procTabRef.current[id];
        setRunningTasks((prev) => {
          const next = { ...prev };
          for (const [taskId, procId] of Object.entries(next)) {
            if (procId === id) delete next[taskId];
          }
          return next;
        });
        // Si el id que terminó es el de un servicio (no el de una corrida
        // de tarea), se marca detenido. Es la única forma en que se pone
        // en false: nunca por chequeo de puerto, siempre por el id puntual
        // que esta app lanzó.
        if (
          projectsRef.current.some((p) => p.services.some((s) => s.id === id))
        ) {
          setRunningServices((prev) => ({ ...prev, [id]: false }));
        }
        if (stream === "exit") notifyTaskFinished(id);

        const resolve = pendingExitResolvers.current[id];
        if (resolve) {
          delete pendingExitResolvers.current[id];
          resolve(stream === "exit" ? (code ?? null) : null);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Sincronización única al cargar: por si el registro de PIDs de Rust ya
  // tenía algo (ej: la ventana se recargó pero el proceso de Tauri sigue
  // vivo). No es un polling — se corre una sola vez cuando termina de
  // cargar la configuración guardada.
  useEffect(() => {
    if (!loaded) return;
    projects.forEach((p) =>
      p.services.forEach((service) => {
        invoke<boolean>("is_process_alive", { id: service.id })
          .then((alive) =>
            setRunningServices((prev) => ({ ...prev, [service.id]: alive })),
          )
          .catch(() => {});
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Carga la configuración guardada (projects.json) al iniciar la app.
  // Si no hay nada guardado (primera vez), se queda con el proyecto de ejemplo.
  useEffect(() => {
    invoke<Project[]>("load_projects")
      .then((saved) => {
        if (saved && saved.length > 0) setProjects(saved);
      })
      .catch((err) =>
        addLog(GENERAL, "error", `Error al cargar configuración: ${err}`),
      )
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persiste automáticamente cada cambio en la lista de proyectos.
  // El guard `loaded` evita pisar el archivo guardado con el seed inicial
  // antes de que termine de cargar.
  useEffect(() => {
    if (!loaded) return;
    invoke("save_projects", { projects }).catch((err) =>
      addLog(GENERAL, "error", `Error al guardar configuración: ${err}`),
    );
  }, [projects, loaded]);

  // Al cerrar la ventana, mata todo lo que la app lanzó y que pueda seguir
  // vivo (servicios por puerto, tareas por PID) antes de dejarla cerrar de
  // verdad. Sin esto, un dev server que quedó corriendo sigue vivo en
  // segundo plano después de cerrar la app, ocupando su puerto sin que se
  // note por qué. Usa exactamente los mismos comandos que los botones
  // "Matar"/"Detener" manuales.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        const services = projectsRef.current.flatMap((p) => p.services);
        const procIds = Object.values(runningTasksRef.current);
        await Promise.allSettled([
          ...services.map((s) => invoke("kill_port", { port: s.port })),
          ...procIds.map((procId) => invoke("kill_process", { id: procId })),
        ]);
        await getCurrentWindow().destroy();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

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
        taskGroups: [],
      };
      setProjects((prev) => [
        ...prev,
        { id: projectId, name, services: [service] },
      ]);
      addLog(GENERAL, "action", `Proyecto "${name}" agregado.`);
      setModal(null);
    } else if (modal.kind === "editProject") {
      const { name, proj } = modal;
      if (!name) return;
      setProjects((prev) =>
        prev.map((p) => (p.id === proj.id ? { ...p, name } : p)),
      );
      addLog(GENERAL, "action", `Proyecto renombrado a "${name}".`);
      setModal(null);
    }
  };

  const askDeleteProject = async (proj: Project) => {
    // Alerta nativa real del sistema (NSAlert en macOS) en vez de un modal
    // dibujado en la página: a diferencia de los formularios, una
    // confirmación sí encaja en lo que un diálogo nativo puede mostrar
    // (título + mensaje + botones).
    const confirmed = await ask(
      `Se liberarán los puertos de sus ${proj.services.length} servicio(s) y se perderán sus tareas.`,
      { title: `¿Eliminar proyecto "${proj.name}"?`, kind: "warning" },
    );
    if (confirmed) deleteProject(proj);
  };

  const deleteProject = async (proj: Project) => {
    // Mata los procesos escuchando en los puertos de todos los servicios del
    // proyecto antes de quitarlo, para no dejar procesos huérfanos corriendo
    // en segundo plano una vez que el proyecto ya no es visible.
    for (const service of proj.services) {
      try {
        const res = await invoke<string>("kill_port", { port: service.port });
        addLog(GENERAL, "action", `Puerto ${service.port}: ${res}`);
      } catch (err) {
        addLog(
          GENERAL,
          "error",
          `Error al liberar puerto ${service.port}: ${err}`,
        );
      }
    }

    setProjects((prev) => prev.filter((p) => p.id !== proj.id));
    setLogsByTab((prev) => {
      const rest = { ...prev };
      for (const service of proj.services) delete rest[service.id];
      return rest;
    });
    if (proj.services.some((s) => s.id === activeTab)) setActiveTab(GENERAL);
    addLog(GENERAL, "action", `Proyecto "${proj.name}" eliminado.`);
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
        env: service.env,
      },
    });
  };

  const submitServiceModal = () => {
    if (!modal) return;
    if (modal.kind === "createService") {
      const { proj, fields } = modal;
      if (!fields.name || !fields.path) return;
      const newService: Service = {
        ...fields,
        id: Date.now().toString(),
        tasks: [],
        taskGroups: [],
      };
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? { ...p, services: [...p.services, newService] }
            : p,
        ),
      );
      addLog(
        GENERAL,
        "action",
        `Servicio "${newService.name}" agregado a ${proj.name}.`,
      );
      setModal(null);
    } else if (modal.kind === "editService") {
      const { proj, service, fields } = modal;
      if (!fields.name || !fields.path) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) =>
                  s.id === service.id ? { ...s, ...fields } : s,
                ),
              }
            : p,
        ),
      );
      addLog(
        GENERAL,
        "action",
        `Servicio "${fields.name}" actualizado en ${proj.name}.`,
      );
      setModal(null);
    }
  };

  const askDeleteService = async (proj: Project, service: Service) => {
    const confirmed = await ask(
      `Se liberará el puerto ${service.port} y se perderán sus tareas.`,
      { title: `¿Eliminar servicio "${service.name}"?`, kind: "warning" },
    );
    if (confirmed) deleteService(proj, service);
  };

  const deleteService = async (proj: Project, service: Service) => {
    try {
      const res = await invoke<string>("kill_port", { port: service.port });
      addLog(GENERAL, "action", `Puerto ${service.port}: ${res}`);
    } catch (err) {
      addLog(
        GENERAL,
        "error",
        `Error al liberar puerto ${service.port}: ${err}`,
      );
    }
    setProjects((prev) =>
      prev.map((p) =>
        p.id === proj.id
          ? { ...p, services: p.services.filter((s) => s.id !== service.id) }
          : p,
      ),
    );
    setLogsByTab((prev) => {
      const { [service.id]: _discard, ...rest } = prev;
      return rest;
    });
    if (activeTab === service.id) setActiveTab(GENERAL);
    addLog(
      GENERAL,
      "action",
      `Servicio "${service.name}" eliminado de ${proj.name}.`,
    );
  };

  const runService = async (
    service: Service,
    opts: { switchTab?: boolean } = {},
  ) => {
    const { switchTab = true } = opts;
    if (switchTab) setActiveTab(service.id);
    try {
      const res = await invoke<string>("run_project_command", {
        id: service.id,
        path: service.path,
        command: withEnv(service.command, service.env),
      });
      addLog(service.id, "success", res);
      // Se marca corriendo apenas el spawn confirma éxito; se vuelve a
      // false únicamente cuando llegue el evento "exit"/"error" de este
      // mismo id (ver el listener de "project-log"), nunca por el puerto.
      setRunningServices((prev) => ({ ...prev, [service.id]: true }));
    } catch (err) {
      addLog(service.id, "error", `Error al iniciar: ${err}`);
      setRunningServices((prev) => ({ ...prev, [service.id]: false }));
    }
  };

  const killService = async (
    service: Service,
    opts: { switchTab?: boolean } = {},
  ) => {
    const { switchTab = true } = opts;
    if (switchTab) setActiveTab(service.id);
    try {
      const res = await invoke<string>("kill_port", { port: service.port });
      addLog(service.id, "action", `Puerto ${service.port}: ${res}`);
    } catch (err) {
      addLog(
        service.id,
        "error",
        `Error al liberar puerto ${service.port}: ${err}`,
      );
    }
    // No se pisa el estado acá: el "exit" del proceso que esta app lanzó
    // para este servicio es lo que efectivamente lo marca detenido.
  };

  // Mantiene el menú de la bandeja al día con los servicios actuales y su
  // estado, para que se vea igual de fresco ahí que en la ventana.
  useEffect(() => {
    const trayServices = projects.flatMap((proj) =>
      proj.services.map((service) => ({
        id: service.id,
        label: `${proj.name} · ${service.name}`,
        running: !!runningServices[service.id],
      })),
    );
    invoke("update_tray_menu", { services: trayServices }).catch(() => {
      // Sin bandeja no es crítico; la app sigue funcionando desde la ventana.
    });
  }, [projects, runningServices]);

  // Click en un servicio desde el menú de la bandeja: alterna iniciar/matar
  // según el último estado de puerto conocido, igual que el botón ▶/■ de
  // la ventana.
  useEffect(() => {
    const unlisten = listen<string>("tray-toggle-service", (event) => {
      const serviceId = event.payload;
      const service = projectsRef.current
        .flatMap((p) => p.services)
        .find((s) => s.id === serviceId);
      if (!service) return;
      if (runningServicesRef.current[serviceId]) killService(service);
      else runService(service);
    });
    return () => {
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openService = async (service: Service) => {
    try {
      await invoke("open_browser_url", { url: service.url });
      addLog(service.id, "action", `Abriendo ${service.url}`);
    } catch (err) {
      addLog(service.id, "error", `Error al abrir URL: ${err}`);
    }
  };

  // Inicia/mata todos los servicios del proyecto de una sola vez (ej: levantar
  // front y back juntos). No cambiamos de pestaña por cada uno para no saltar
  // de una a otra; se deja la del primer servicio como referencia visual.
  const runAllServices = (proj: Project) => {
    if (proj.services.length === 0) return;
    setActiveTab(proj.services[0].id);
    proj.services.forEach((service) =>
      runService(service, { switchTab: false }),
    );
  };

  const killAllServices = (proj: Project) => {
    proj.services.forEach((service) =>
      killService(service, { switchTab: false }),
    );
  };

  // --- Tareas puntuales de un servicio ---

  const openCreateTask = (proj: Project, service: Service) =>
    setModal({ kind: "createTask", proj, service, fields: emptyTaskForm });

  const openEditTask = (proj: Project, service: Service, task: Task) =>
    setModal({
      kind: "editTask",
      proj,
      service,
      task,
      fields: { name: task.name, command: task.command, env: task.env },
    });

  const submitTaskModal = () => {
    if (!modal) return;
    if (modal.kind === "createTask") {
      const { proj, service, fields } = modal;
      if (!fields.name || !fields.command) return;
      const newTask: Task = {
        id: Date.now().toString(),
        name: fields.name,
        command: fields.command,
        env: fields.env,
      };
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) =>
                  s.id === service.id
                    ? { ...s, tasks: [...s.tasks, newTask] }
                    : s,
                ),
              }
            : p,
        ),
      );
      addLog(
        GENERAL,
        "action",
        `Tarea "${newTask.name}" agregada a ${proj.name} · ${service.name}.`,
      );
      setModal(null);
    } else if (modal.kind === "editTask") {
      const { proj, service, task, fields } = modal;
      if (!fields.name || !fields.command) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) =>
                  s.id === service.id
                    ? {
                        ...s,
                        tasks: s.tasks.map((t) =>
                          t.id === task.id ? { ...t, ...fields } : t,
                        ),
                      }
                    : s,
                ),
              }
            : p,
        ),
      );
      addLog(
        GENERAL,
        "action",
        `Tarea "${fields.name}" actualizada en ${proj.name} · ${service.name}.`,
      );
      setModal(null);
    }
  };

  const askDeleteTask = async (proj: Project, service: Service, task: Task) => {
    const confirmed = await ask(`Se eliminará la tarea "${task.name}".`, {
      title: `¿Eliminar tarea "${task.name}"?`,
      kind: "warning",
    });
    if (confirmed) deleteTask(proj, service, task);
  };

  const deleteTask = (proj: Project, service: Service, task: Task) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === proj.id
          ? {
              ...p,
              services: p.services.map((s) =>
                s.id === service.id
                  ? { ...s, tasks: s.tasks.filter((t) => t.id !== task.id) }
                  : s,
              ),
            }
          : p,
      ),
    );
    addLog(
      GENERAL,
      "action",
      `Tarea "${task.name}" eliminada de ${proj.name} · ${service.name}.`,
    );
  };

  // --- Grupos de tareas (correr varias tareas del servicio en secuencia) ---

  const openCreateTaskGroup = (proj: Project, service: Service) =>
    setModal({
      kind: "createTaskGroup",
      proj,
      service,
      fields: emptyTaskGroupForm,
    });

  const openEditTaskGroup = (
    proj: Project,
    service: Service,
    group: TaskGroup,
  ) =>
    setModal({
      kind: "editTaskGroup",
      proj,
      service,
      group,
      fields: { name: group.name, taskIds: group.taskIds },
    });

  const submitTaskGroupModal = () => {
    if (!modal) return;
    if (modal.kind === "createTaskGroup") {
      const { proj, service, fields } = modal;
      if (!fields.name || fields.taskIds.length === 0) return;
      const newGroup: TaskGroup = { id: Date.now().toString(), ...fields };
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) =>
                  s.id === service.id
                    ? { ...s, taskGroups: [...s.taskGroups, newGroup] }
                    : s,
                ),
              }
            : p,
        ),
      );
      addLog(
        GENERAL,
        "action",
        `Grupo "${newGroup.name}" agregado a ${proj.name} · ${service.name}.`,
      );
      setModal(null);
    } else if (modal.kind === "editTaskGroup") {
      const { proj, service, group, fields } = modal;
      if (!fields.name || fields.taskIds.length === 0) return;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === proj.id
            ? {
                ...p,
                services: p.services.map((s) =>
                  s.id === service.id
                    ? {
                        ...s,
                        taskGroups: s.taskGroups.map((g) =>
                          g.id === group.id ? { ...g, ...fields } : g,
                        ),
                      }
                    : s,
                ),
              }
            : p,
        ),
      );
      addLog(
        GENERAL,
        "action",
        `Grupo "${fields.name}" actualizado en ${proj.name} · ${service.name}.`,
      );
      setModal(null);
    }
  };

  const askDeleteTaskGroup = async (
    proj: Project,
    service: Service,
    group: TaskGroup,
  ) => {
    const confirmed = await ask(`Se eliminará el grupo "${group.name}".`, {
      title: `¿Eliminar grupo "${group.name}"?`,
      kind: "warning",
    });
    if (!confirmed) return;
    setProjects((prev) =>
      prev.map((p) =>
        p.id === proj.id
          ? {
              ...p,
              services: p.services.map((s) =>
                s.id === service.id
                  ? {
                      ...s,
                      taskGroups: s.taskGroups.filter((g) => g.id !== group.id),
                    }
                  : s,
              ),
            }
          : p,
      ),
    );
    addLog(
      GENERAL,
      "action",
      `Grupo "${group.name}" eliminado de ${proj.name} · ${service.name}.`,
    );
  };

  // Corre el comando final (ya con los parámetros sustituidos) reusando el
  // mismo backend que el comando principal del servicio: transmite
  // stdout/stderr en vivo y avisa cuando el proceso termina (evento "exit"),
  // tal como pide el uso "npm run test" o similar que empieza y acaba solo.
  //
  // Usa un id de proceso propio (no el del servicio) para que el backend
  // pueda rastrear su PID por separado: una tarea no tiene puerto propio,
  // así que la única forma de poder detenerla es matándola por PID, sin
  // pisar el PID del proceso principal del servicio si ese también está
  // corriendo al mismo tiempo. La salida sigue yendo a la pestaña del
  // servicio vía procTabRef.
  //
  // Devuelve también una promesa que resuelve con el código de salida (o
  // `null` si ni llegó a arrancar). El botón ▶ individual la ignora; los
  // grupos de tareas la esperan para correr sus pasos en secuencia.
  const startTaskProcess = (
    service: Service,
    task: Task,
    command: string,
  ): { procId: string; done: Promise<number | null> } => {
    const procId = `${service.id}:task:${task.id}:${Date.now()}`;
    procTabRef.current[procId] = service.id;
    taskNameByProcRef.current[procId] = task.name;
    setRunningTasks((prev) => ({ ...prev, [task.id]: procId }));

    const done = new Promise<number | null>((resolve) => {
      pendingExitResolvers.current[procId] = resolve;
    });

    setActiveTab(service.id);
    addLog(service.id, "action", `Tarea "${task.name}": ${command}`);
    invoke<string>("run_project_command", {
      id: procId,
      path: service.path,
      command: withEnv(command, service.env, task.env),
    })
      .then((res) => addLog(service.id, "success", res))
      .catch((err) => {
        addLog(service.id, "error", `Error al ejecutar tarea: ${err}`);
        delete taskNameByProcRef.current[procId];
        setRunningTasks((prev) => {
          const { [task.id]: _discard, ...rest } = prev;
          return rest;
        });
        const resolve = pendingExitResolvers.current[procId];
        delete pendingExitResolvers.current[procId];
        resolve?.(null);
      });

    return { procId, done };
  };

  const runTaskCommand = (service: Service, task: Task, command: string) => {
    startTaskProcess(service, task, command);
  };

  // Corre las tareas de un grupo una por una, esperando a que cada una
  // termine antes de lanzar la siguiente; si alguna termina con código de
  // salida distinto de cero, corta ahí en vez de seguir con el resto. Las
  // tareas con placeholders {{param}} pendientes se saltan (no tiene
  // sentido pedir un valor a mitad de una corrida desatendida).
  const runTaskGroup = async (service: Service, group: TaskGroup) => {
    for (const taskId of group.taskIds) {
      const task = service.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      if (extractParams(task.command).length > 0) {
        addLog(
          service.id,
          "error",
          `Grupo "${group.name}": "${task.name}" tiene parámetros pendientes, se saltea.`,
        );
        continue;
      }
      const { done } = startTaskProcess(service, task, task.command);
      const code = await done;
      if (code !== 0) {
        addLog(
          service.id,
          "error",
          `Grupo "${group.name}" detenido: "${task.name}" terminó con código ${code}.`,
        );
        return;
      }
    }
    addLog(service.id, "success", `Grupo "${group.name}" completado.`);
  };

  const stopTask = async (service: Service, task: Task) => {
    const procId = runningTasks[task.id];
    if (!procId) return;
    try {
      const res = await invoke<string>("kill_process", { id: procId });
      addLog(service.id, "action", `Tarea "${task.name}": ${res}`);
    } catch (err) {
      addLog(service.id, "error", `Error al detener la tarea: ${err}`);
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
                  prev &&
                  (prev.kind === "createProject" || prev.kind === "editProject")
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
                        ? {
                            ...prev,
                            service: { ...prev.service, name: e.target.value },
                          }
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
                        ? {
                            ...prev,
                            service: { ...prev.service, path: e.target.value },
                          }
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
                        ? {
                            ...prev,
                            service: {
                              ...prev.service,
                              command: e.target.value,
                            },
                          }
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
                              service: {
                                ...prev.service,
                                port: Number(e.target.value),
                              },
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
                          ? {
                              ...prev,
                              service: { ...prev.service, url: e.target.value },
                            }
                          : prev,
                      )
                    }
                  />
                </div>
              </>
            )}
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitProjectModal}>
                Guardar
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
                  prev &&
                  (prev.kind === "createService" || prev.kind === "editService")
                    ? {
                        ...prev,
                        fields: { ...prev.fields, name: e.target.value },
                      }
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
                  prev &&
                  (prev.kind === "createService" || prev.kind === "editService")
                    ? {
                        ...prev,
                        fields: { ...prev.fields, path: e.target.value },
                      }
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
                  prev &&
                  (prev.kind === "createService" || prev.kind === "editService")
                    ? {
                        ...prev,
                        fields: { ...prev.fields, command: e.target.value },
                      }
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
                    prev &&
                    (prev.kind === "createService" ||
                      prev.kind === "editService")
                      ? {
                          ...prev,
                          fields: {
                            ...prev.fields,
                            port: Number(e.target.value),
                          },
                        }
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
                    prev &&
                    (prev.kind === "createService" ||
                      prev.kind === "editService")
                      ? {
                          ...prev,
                          fields: { ...prev.fields, url: e.target.value },
                        }
                      : prev,
                  )
                }
              />
            </div>
            <EnvEditor
              env={modal.fields.env}
              onChange={(env) =>
                setModal((prev) =>
                  prev &&
                  (prev.kind === "createService" || prev.kind === "editService")
                    ? { ...prev, fields: { ...prev.fields, env } }
                    : prev,
                )
              }
            />
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitServiceModal}>
                Guardar
              </button>
              <button className="btn btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
            </div>
          </>
        );
      }

      case "createTask":
      case "editTask":
        return (
          <>
            <h4>
              {modal.kind === "createTask"
                ? "Nueva tarea en"
                : "Editar tarea en"}{" "}
              "{modal.proj.name} · {modal.service.name}"
            </h4>
            <input
              className="form-input"
              placeholder="Nombre (ej: Test)"
              value={modal.fields.name}
              autoFocus
              onChange={(e) =>
                setModal((prev) =>
                  prev &&
                  (prev.kind === "createTask" || prev.kind === "editTask")
                    ? {
                        ...prev,
                        fields: { ...prev.fields, name: e.target.value },
                      }
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
                  prev &&
                  (prev.kind === "createTask" || prev.kind === "editTask")
                    ? {
                        ...prev,
                        fields: { ...prev.fields, command: e.target.value },
                      }
                    : prev,
                )
              }
            />
            <EnvEditor
              env={modal.fields.env}
              onChange={(env) =>
                setModal((prev) =>
                  prev &&
                  (prev.kind === "createTask" || prev.kind === "editTask")
                    ? { ...prev, fields: { ...prev.fields, env } }
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

      case "createTaskGroup":
      case "editTaskGroup":
        return (
          <>
            <h4>
              {modal.kind === "createTaskGroup"
                ? "Nuevo grupo en"
                : "Editar grupo en"}{" "}
              "{modal.proj.name} · {modal.service.name}"
            </h4>
            <input
              className="form-input"
              placeholder="Nombre (ej: Lint + Test + Build)"
              value={modal.fields.name}
              autoFocus
              onChange={(e) =>
                setModal((prev) =>
                  prev &&
                  (prev.kind === "createTaskGroup" ||
                    prev.kind === "editTaskGroup")
                    ? {
                        ...prev,
                        fields: { ...prev.fields, name: e.target.value },
                      }
                    : prev,
                )
              }
            />
            <div className="task-group-picker">
              {modal.service.tasks.length === 0 ? (
                <p className="modal-sub">
                  Este servicio todavía no tiene tareas para agrupar.
                </p>
              ) : (
                modal.service.tasks.map((task) => {
                  const order = modal.fields.taskIds.indexOf(task.id);
                  const selected = order !== -1;
                  return (
                    <label key={task.id} className="task-group-pick">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() =>
                          setModal((prev) => {
                            if (
                              !prev ||
                              (prev.kind !== "createTaskGroup" &&
                                prev.kind !== "editTaskGroup")
                            ) {
                              return prev;
                            }
                            const taskIds = prev.fields.taskIds.includes(
                              task.id,
                            )
                              ? prev.fields.taskIds.filter(
                                  (id) => id !== task.id,
                                )
                              : [...prev.fields.taskIds, task.id];
                            return {
                              ...prev,
                              fields: { ...prev.fields, taskIds },
                            };
                          })
                        }
                      />
                      {selected ? `${order + 1}. ` : ""}
                      {task.name}
                    </label>
                  );
                })
              )}
            </div>
            <div className="form-actions">
              <button className="btn btn-save" onClick={submitTaskGroupModal}>
                Guardar
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
                      ? {
                          ...prev,
                          values: { ...prev.values, [p]: e.target.value },
                        }
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
                Ejecutar
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
    <div className="app-shell">
      {/* Menú vertical (estilo System Settings/Mail de macOS): la sección
          activa decide qué se muestra a la derecha, en vez de tabs arriba. */}
      <nav className="sidebar">
        <SidebarItem
          active={activeView === "projects"}
          onClick={() => setActiveView("projects")}
          title="Proyectos"
          icon={<IconFolder />}
          label="Proyectos"
        />
        <SidebarItem
          active={activeView === "environment"}
          onClick={() => setActiveView("environment")}
          title="Entorno"
          icon={<IconCpu />}
          label="Entorno"
        />
      </nav>

      <div className="app-container">
        {activeView === "environment" ? (
          <EnvironmentView
            status={environmentStatus}
            loading={environmentLoading}
            onRefresh={checkEnvironment}
          />
        ) : (
          <>
            <div className="header-section">
              <h2>Panel de Proyectos Locales</h2>
              <button className="btn btn-save" onClick={openCreateProject}>
                <IconPlus /> Nuevo Proyecto
              </button>
            </div>

            {/* En pantallas grandes, la terminal queda fija a la izquierda (para
          poder seguir la salida en vivo) y los proyectos/tareas a la
          derecha; en pantallas chicas se apilan en una sola columna, en el
          orden natural: primero proyectos, terminal debajo. */}
            <div className="main-layout">
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
                          {expandedProjectIds.has(proj.id) ? (
                            <>
                              <IconChevronDown /> Vista mínima
                            </>
                          ) : (
                            <>
                              <IconChevronRight /> Vista completa
                            </>
                          )}
                        </button>
                        <button
                          className="btn btn-action btn-run"
                          onClick={() => runAllServices(proj)}
                          disabled={proj.services.every(
                            (s) => runningServices[s.id],
                          )}
                        >
                          <IconPlay /> Iniciar todo
                        </button>
                        <button
                          className="btn btn-action btn-kill"
                          onClick={() => killAllServices(proj)}
                        >
                          <IconStop /> Matar todo
                        </button>
                        <button
                          className="btn btn-action btn-edit"
                          onClick={() => openEditProject(proj)}
                        >
                          <IconPencil /> Renombrar
                        </button>
                        <button
                          className="btn btn-action btn-delete btn-icon-only"
                          onClick={() => askDeleteProject(proj)}
                          title="Eliminar proyecto"
                        >
                          <IconTrash />
                        </button>
                      </div>
                    </div>

                    <div className="services-list">
                      {!expandedProjectIds.has(proj.id) && (
                        // Vista mínima: solo el punto de estado + íconos de acción
                        // por servicio, sin nombre/puerto/ruta/comando a la vista
                        // (van en el title, como tooltip del chip completo).
                        <div className="services-mini-row">
                          {proj.services.map((service) => (
                            <ServiceChipMini
                              key={service.id}
                              service={service}
                              running={!!runningServices[service.id]}
                              onSelect={(s) => setActiveTab(s.id)}
                              onRun={runService}
                              onKill={killService}
                            />
                          ))}
                        </div>
                      )}

                      {expandedProjectIds.has(proj.id) &&
                        proj.services.map((service) => (
                          <ServiceCard
                            key={service.id}
                            proj={proj}
                            service={service}
                            running={!!runningServices[service.id]}
                            runningTasks={runningTasks}
                            onRun={runService}
                            onKill={killService}
                            onOpen={openService}
                            onViewTerminal={(s) => setActiveTab(s.id)}
                            onEditService={openEditService}
                            onDeleteService={askDeleteService}
                            openCreateTask={openCreateTask}
                            openEditTask={openEditTask}
                            askDeleteTask={askDeleteTask}
                            handleRunTask={handleRunTask}
                            stopTask={stopTask}
                            openCreateTaskGroup={openCreateTaskGroup}
                            openEditTaskGroup={openEditTaskGroup}
                            askDeleteTaskGroup={askDeleteTaskGroup}
                            runTaskGroup={runTaskGroup}
                          />
                        ))}

                      {expandedProjectIds.has(proj.id) && (
                        <BtnAddService
                          openCreateService={openCreateService}
                          proj={proj}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Terminales por servicio */}
              <div className="console-section">
                <div className="console-section-header">
                  <button
                    className="btn btn-action btn-view-toggle"
                    onClick={() => setTerminalCollapsed((prev) => !prev)}
                  >
                    {terminalCollapsed ? (
                      <IconChevronRight />
                    ) : (
                      <IconChevronDown />
                    )}
                    <h4>Terminales</h4>
                  </button>
                  {!terminalCollapsed && (
                    <button
                      className="btn btn-action btn-clear-log"
                      onClick={() =>
                        setLogsByTab((prev) => ({ ...prev, [activeTab]: [] }))
                      }
                    >
                      Limpiar
                    </button>
                  )}
                </div>
                {!terminalCollapsed && (
                  <>
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
                    <div
                      className="console-box"
                      ref={consoleBoxRef}
                      onScroll={handleConsoleScroll}
                    >
                      {(logsByTab[activeTab] ?? []).length === 0 ? (
                        <span className="console-placeholder">
                          Sin actividad en esta terminal todavía...
                        </span>
                      ) : (
                        (logsByTab[activeTab] ?? []).map((entry, i) => (
                          <div key={i} className={`log-line log-${entry.kind}`}>
                            <span className="log-time">{entry.time}</span>
                            <LogIcon kind={entry.kind} />
                            <span className="log-text">{entry.text}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Modal único: agrupa formularios de creación/edición. Las
          confirmaciones de borrado usan ask() (alerta nativa del sistema)
          en vez de este modal. No usamos window.prompt porque WKWebView
          (macOS) no lo implementa de forma confiable: la llamada devuelve
          un valor por defecto al instante sin mostrar nada, así que el
          flujo nunca llega a completarse. */}
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
