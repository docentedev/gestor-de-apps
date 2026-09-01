import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

export interface Project {
  id: string;
  name: string;
  path: string;
  url: string;
  port: number;
  command: string;
}

interface ProcessOutput {
  id: string;
  stream: "stdout" | "stderr" | "exit" | "error";
  line: string;
}

const emptyForm: Omit<Project, "id"> = {
  name: "",
  path: "",
  url: "http://localhost:3000",
  port: 3000,
  command: "pnpm run start:dev",
};

export default function App() {
  const [projects, setProjects] = useState<Project[]>([
    {
      id: "1",
      name: "saas-deporte",
      path: "/Users/claudio.viajando/src/personales/saas-deporte",
      url: "http://localhost:3000",
      port: 3000,
      command: "pnpm run start:dev",
    },
  ]);

  const [form, setForm] = useState<Omit<Project, "id">>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Id del proyecto pendiente de confirmación de borrado. No usamos
  // window.confirm porque WKWebView (macOS) no implementa los diálogos JS
  // nativos: la llamada devuelve false al instante sin mostrar nada, y el
  // borrado nunca llega a ejecutarse. Con este estado mostramos una
  // confirmación propia en la UI.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Una terminal por proyecto (clave = id de proyecto) + "_general" para
  // eventos que no pertenecen a un proceso (agregar/editar/eliminar tareas).
  const GENERAL = "_general";
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

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const addProject = () => {
    if (!form.name || !form.path) return;

    if (editingId) {
      setProjects((prev) =>
        prev.map((p) => (p.id === editingId ? { ...form, id: editingId } : p)),
      );
      addLog(GENERAL, ` ✏️ Proyecto ${form.name} actualizado.`);
    } else {
      setProjects((prev) => [...prev, { ...form, id: Date.now().toString() }]);
      addLog(GENERAL, ` ➕ Proyecto ${form.name} agregado.`);
    }
    resetForm();
  };

  const startEdit = (proj: Project) => {
    setEditingId(proj.id);
    setForm({
      name: proj.name,
      path: proj.path,
      url: proj.url,
      port: proj.port,
      command: proj.command,
    });
  };

  const deleteProject = async (proj: Project) => {
    setConfirmDeleteId(null);

    // Mata el proceso que esté escuchando en el puerto del proyecto antes de
    // quitarlo de la lista, para no dejar procesos huérfanos corriendo en
    // segundo plano una vez que la tarea ya no es visible.
    try {
      const res = await invoke<string>("kill_port", { port: proj.port });
      addLog(GENERAL, ` 🛑 Puerto ${proj.port}: ${res}`);
    } catch (err) {
      addLog(GENERAL, ` ❌ Error al liberar puerto ${proj.port}: ${err}`);
    }

    setProjects((prev) => prev.filter((p) => p.id !== proj.id));
    if (editingId === proj.id) resetForm();
    setLogsByTab((prev) => {
      const { [proj.id]: _discard, ...rest } = prev;
      return rest;
    });
    if (activeTab === proj.id) setActiveTab(GENERAL);
    addLog(GENERAL, ` 🗑 Proyecto ${proj.name} eliminado.`);
  };

  const handleRun = async (proj: Project) => {
    setActiveTab(proj.id);
    try {
      const res = await invoke<string>("run_project_command", {
        id: proj.id,
        path: proj.path,
        command: proj.command,
      });
      addLog(proj.id, `▶ ${res}`);
    } catch (err) {
      addLog(proj.id, `❌ Error al iniciar: ${err}`);
    }
  };

  const handleKill = async (proj: Project) => {
    setActiveTab(proj.id);
    try {
      const res = await invoke<string>("kill_port", { port: proj.port });
      addLog(proj.id, `🛑 Puerto ${proj.port}:${res}`);
    } catch (err) {
      addLog(proj.id, `❌ Error al liberar puerto ${proj.port}:${err}`);
    }
  };

  const handleOpen = async (proj: Project) => {
    try {
      await invoke("open_browser_url", { url: proj.url });
      addLog(proj.id, `🌐 Abriendo ${proj.url}`);
    } catch (err) {
      addLog(proj.id, `❌ Error al abrir URL: ${err}`);
    }
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
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <input
                className="form-input"
                placeholder="Ruta local (/Users/...)"
                value={form.path}
                onChange={(e) => setForm({ ...form, path: e.target.value })}
              />
              <input
                className="form-input"
                placeholder="Comando (ej: pnpm run start:dev)"
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
              />
              <div className="form-row">
                <input
                  className="form-input input-port"
                  type="number"
                  placeholder="Puerto"
                  value={form.port}
                  onChange={(e) =>
                    setForm({ ...form, port: Number(e.target.value) })
                  }
                />
                <input
                  className="form-input input-url"
                  placeholder="URL Local"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                />
              </div>
              <div className="form-actions">
                <button className="btn btn-save" onClick={addProject}>
                  {editingId ? "💾 Guardar Cambios" : "+ Guardar Proyecto"}
                </button>
                {editingId && (
                  <button className="btn btn-cancel" onClick={resetForm}>
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
            <div key={proj.id} className="project-card">
              <div className="project-info">
                <span className="project-name">{proj.name}</span>
                <span className="project-path">{proj.path}</span>
                <div className="project-details">
                  <code>{proj.command}</code> • Puerto:{" "}
                  <strong>{proj.port}</strong>
                </div>
              </div>

              <div className="project-actions">
                <button
                  className="btn btn-action btn-run"
                  onClick={() => handleRun(proj)}
                >
                  ▶ Iniciar
                </button>
                <button
                  className="btn btn-action btn-kill"
                  onClick={() => handleKill(proj)}
                >
                  🛑 Matar {proj.port}
                </button>
                <button
                  className="btn btn-action btn-open"
                  onClick={() => handleOpen(proj)}
                >
                  🌐 Abrir
                </button>
                <button
                  className="btn btn-action"
                  onClick={() => setActiveTab(proj.id)}
                >
                  🖥️ Terminal
                </button>
                <button
                  className="btn btn-action btn-edit"
                  onClick={() => startEdit(proj)}
                >
                  ✏️ Editar
                </button>
                {confirmDeleteId === proj.id ? (
                  <>
                    <button
                      className="btn btn-action btn-delete"
                      onClick={() => deleteProject(proj)}
                    >
                      ✅ Confirmar
                    </button>
                    <button
                      className="btn btn-action"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      ✖ Cancelar
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn-action btn-delete"
                    onClick={() => setConfirmDeleteId(proj.id)}
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Terminales por proyecto */}
      <div className="console-section">
        <h4>Terminales</h4>
        <div className="terminal-tabs">
          <button
            className={`terminal-tab ${activeTab === GENERAL ? "active" : ""}`}
            onClick={() => setActiveTab(GENERAL)}
          >
            General
          </button>
          {projects.map((proj) => (
            <button
              key={proj.id}
              className={`terminal-tab ${activeTab === proj.id ? "active" : ""}`}
              onClick={() => setActiveTab(proj.id)}
            >
              {proj.name}
            </button>
          ))}
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
    </div>
  );
}
