use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::menu::{IsMenuItem, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

// Registro en memoria de los procesos que la app lanzó (id de servicio o de
// una corrida de tarea -> pid del shell que lo ejecuta). Solo se usa para
// poder matar por PID a las tareas puntuales, que no tienen puerto propio
// (los servicios se siguen matando por puerto, vía kill_port).
type ProcessRegistry = Mutex<HashMap<String, u32>>;

const TRAY_ID: &str = "main-tray";

#[derive(Clone, serde::Serialize)]
struct ProcessOutput {
    id: String,
    stream: String, // "stdout" | "stderr" | "exit" | "error"
    line: String,
    // Código de salida del proceso; solo viene poblado en el evento "exit".
    // Lo usan los grupos de tareas para saber si un paso falló y hay que
    // detener el resto de la secuencia.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

// Variable de entorno definida por el usuario para un servicio o tarea.
// Vive como lista (no como mapa) porque así se edita más fácil en un
// formulario (permite una fila con la clave vacía a medio completar).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct EnvVarConfig {
    key: String,
    value: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct TaskConfig {
    id: String,
    name: String,
    command: String,
    #[serde(default)]
    env: Vec<EnvVarConfig>,
}

// Grupo de tareas ya existentes del mismo servicio, para correrlas en
// secuencia con un solo botón (se detiene si alguna termina con código de
// salida distinto de cero). Guarda solo los ids; si una tarea referenciada
// se borra después, el frontend simplemente la salta al correr el grupo.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct TaskGroupConfig {
    id: String,
    name: String,
    #[serde(rename = "taskIds")]
    task_ids: Vec<String>,
}

// Un proyecto ahora agrupa uno o más servicios (ej: Front y Back de la misma
// app), cada uno con su propia ruta/comando/puerto/URL y sus propias tareas.
// El proyecto en sí es solo un contenedor organizativo (id + nombre).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ServiceConfig {
    id: String,
    name: String,
    path: String,
    url: String,
    port: u16,
    command: String,
    #[serde(default)]
    tasks: Vec<TaskConfig>,
    #[serde(default)]
    env: Vec<EnvVarConfig>,
    #[serde(default, rename = "taskGroups")]
    task_groups: Vec<TaskGroupConfig>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ProjectConfig {
    id: String,
    name: String,
    // `default` para tolerar el formato viejo (sin "services") al migrar en
    // `migrate_projects_value`; en la práctica siempre llega poblado.
    #[serde(default)]
    services: Vec<ServiceConfig>,
}

// Ruta al archivo de configuración persistente (JSON) en el directorio de
// config de la app. No usamos SQLite porque esto es solo una lista pequeña
// de registros sin necesidad de queries relacionales; un archivo plano basta.
fn projects_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("projects.json"))
}

// Convierte el formato viejo de projects.json (un proyecto = un solo
// servicio, con path/url/port/command/tasks directamente en el proyecto) al
// formato actual (proyecto -> lista de servicios). Sin esto, cargar un
// archivo guardado antes de este cambio perdería toda la configuración: al
// no existir el campo "services", el `#[serde(default)]` de ProjectConfig
// lo dejaría vacío y el proyecto quedaría sin ningún servicio.
fn migrate_projects_value(mut value: serde_json::Value) -> serde_json::Value {
    if let serde_json::Value::Array(projects) = &mut value {
        for project in projects {
            let Some(obj) = project.as_object_mut() else { continue };
            let has_services = matches!(obj.get("services"), Some(serde_json::Value::Array(_)));
            if has_services || !obj.contains_key("path") {
                continue;
            }
            let id = obj
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("service")
                .to_string();
            let service = serde_json::json!({
                "id": format!("{}-svc", id),
                "name": "Principal",
                "path": obj.remove("path").unwrap_or(serde_json::Value::String(String::new())),
                "url": obj.remove("url").unwrap_or(serde_json::Value::String(String::new())),
                "port": obj.remove("port").unwrap_or(serde_json::Value::Number(0.into())),
                "command": obj.remove("command").unwrap_or(serde_json::Value::String(String::new())),
                "tasks": obj.remove("tasks").unwrap_or(serde_json::Value::Array(vec![])),
            });
            obj.insert("services".to_string(), serde_json::Value::Array(vec![service]));
        }
    }
    value
}

#[tauri::command]
fn load_projects(app: AppHandle) -> Result<Vec<ProjectConfig>, String> {
    let path = projects_file_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    let migrated = migrate_projects_value(value);
    serde_json::from_value(migrated).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_projects(app: AppHandle, projects: Vec<ProjectConfig>) -> Result<(), String> {
    let path = projects_file_path(&app)?;
    let data = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Indica si algo está escuchando en el puerto, sin matar nada. Se usa para
// pintar el indicador de corriendo/detenido de cada servicio.
#[tauri::command]
fn is_port_in_use(port: u16) -> Result<bool, String> {
    let output = Command::new("zsh")
        .arg("-c")
        .arg(format!("lsof -ti :{} -sTCP:LISTEN", port))
        .output()
        .map_err(|e| e.to_string())?;
    Ok(!output.stdout.is_empty())
}

// Mata por PID un proceso lanzado por run_project_command, buscándolo en el
// registro en memoria. Pensado para tareas puntuales (npm run test, etc.)
// que no tienen un puerto propio del que valerse para matarlas; los
// servicios siguen usando kill_port. Si el proceso ya terminó (o el id no
// está registrado), no es un error: simplemente no había nada que matar.
#[tauri::command]
fn kill_process(id: String, app: AppHandle) -> Result<String, String> {
    let registry = app.state::<ProcessRegistry>();
    let mut guard = registry.lock().map_err(|e| e.to_string())?;
    let pid = guard.remove(&id);
    drop(guard);
    match pid {
        Some(pid) => {
            Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .output()
                .map_err(|e| e.to_string())?;
            Ok(format!("Proceso {} detenido", pid))
        }
        None => Ok("El proceso ya había terminado".to_string()),
    }
}

// Mata el proceso escuchando en el puerto sin fallar si el puerto ya está libre
#[tauri::command]
fn kill_port(port: u16) -> Result<String, String> {
    // -sTCP:LISTEN filtra solo el proceso que realmente escucha en el puerto;
    // sin ese filtro, lsof también devuelve procesos con una conexión abierta
    // HACIA ese puerto (ej: el navegador con el websocket de HMR de Vite),
    // lo que puede romper el && y reportar "no estaba en uso" incluso cuando
    // el servidor sí está corriendo (o peor, matar el proceso equivocado).
    let script = format!(
        "PID=$(lsof -ti :{} -sTCP:LISTEN) && [ -n \"$PID\" ] && kill -9 $PID && echo 'Puerto liberado' || echo 'Puerto no estaba en uso'",
        port
    );

    let output = Command::new("zsh")
        .arg("-c")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// Ejecuta el script cargando las variables de entorno de macOS (.zshrc) y
// transmite stdout/stderr en vivo al frontend vía el evento "project-log".
#[tauri::command]
fn run_project_command(
    app: AppHandle,
    id: String,
    path: String,
    command: String,
) -> Result<String, String> {
    let full_command = format!(
        "source ~/.zshrc 2>/dev/null || source ~/.bash_profile 2>/dev/null; {}",
        command
    );

    let mut child = Command::new("zsh")
        .arg("-l")
        .arg("-c")
        .arg(&full_command)
        .current_dir(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Error al iniciar proceso: {}", e))?;

    {
        let registry = app.state::<ProcessRegistry>();
        registry
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), child.id());
    }

    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        let id_clone = id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                let _ = app_handle.emit(
                    "project-log",
                    ProcessOutput { id: id_clone.clone(), stream: "stdout".into(), line, code: None },
                );
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_handle = app.clone();
        let id_clone = id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                let _ = app_handle.emit(
                    "project-log",
                    ProcessOutput { id: id_clone.clone(), stream: "stderr".into(), line, code: None },
                );
            }
        });
    }

    thread::spawn(move || {
        let status = child.wait();
        let registry = app.state::<ProcessRegistry>();
        let mut guard = registry.lock().unwrap();
        guard.remove(&id);
        drop(guard);
        if let Ok(status) = status {
            let _ = app.emit(
                "project-log",
                ProcessOutput {
                    id,
                    stream: "exit".into(),
                    line: format!("Proceso finalizado (código {:?})", status.code()),
                    code: status.code(),
                },
            );
        }
    });

    Ok(format!("Ejecutando '{}' en {}", command, path))
}

#[derive(serde::Deserialize)]
struct TrayServiceInfo {
    id: String,
    label: String,
    running: bool,
}

// Reconstruye el menú del ícono de bandeja con la lista de servicios y su
// estado actual (● corriendo / ○ detenido). El frontend es dueño de esa
// información (proyectos + polling de puertos), así que la empuja cada vez
// que cambia en vez de que Rust intente rastrearla por su cuenta.
#[tauri::command]
fn update_tray_menu(app: AppHandle, services: Vec<TrayServiceInfo>) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("No se encontró el ícono de bandeja")?;

    let show_item = MenuItemBuilder::with_id("show-window", "Mostrar ventana")
        .build(&app)
        .map_err(|e| e.to_string())?;

    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![Box::new(show_item)];
    items.push(Box::new(
        PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
    ));

    if services.is_empty() {
        let empty_item = MenuItemBuilder::with_id("no-services", "Sin servicios")
            .enabled(false)
            .build(&app)
            .map_err(|e| e.to_string())?;
        items.push(Box::new(empty_item));
    } else {
        for service in &services {
            let dot = if service.running { "●" } else { "○" };
            let item = MenuItemBuilder::with_id(format!("svc:{}", service.id), format!("{} {}", dot, service.label))
                .build(&app)
                .map_err(|e| e.to_string())?;
            items.push(Box::new(item));
        }
    }

    items.push(Box::new(
        PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
    ));
    let quit_item = MenuItemBuilder::with_id("quit", "Salir")
        .build(&app)
        .map_err(|e| e.to_string())?;
    items.push(Box::new(quit_item));

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|item| item.as_ref()).collect();
    let menu = MenuBuilder::new(&app)
        .items(&refs)
        .build()
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

// Abre la URL local en el navegador por defecto
#[tauri::command]
fn open_browser_url(url: String) -> Result<String, String> {
    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok("URL abierta".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ProcessRegistry::default())
        .setup(|app| {
            // Ícono de bandeja: estado rápido de los servicios y acceso sin
            // tener que abrir la ventana completa. El menú arranca vacío
            // (solo Mostrar ventana / Salir); el frontend lo puebla con los
            // servicios reales apenas carga, vía update_tray_menu.
            let show_item = MenuItemBuilder::with_id("show-window", "Mostrar ventana").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Salir").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;

            // Si por lo que sea no hay ícono default (no debería pasar, dado
            // que tauri.conf.json declara uno), se salta la bandeja en vez
            // de hacer panic y tirar abajo toda la app al arrancar.
            if let Some(icon) = app.default_window_icon().cloned() {
                TrayIconBuilder::with_id(TRAY_ID)
                    .icon(icon)
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show-window" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        // Pasa por el mismo cierre de ventana que el botón
                        // rojo: el frontend intercepta ese cierre para matar
                        // todo lo que la app lanzó antes de dejarla cerrar
                        // de verdad.
                        "quit" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.close();
                            }
                        }
                        id => {
                            if let Some(service_id) = id.strip_prefix("svc:") {
                                let _ = app.emit("tray-toggle-service", service_id.to_string());
                            }
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            kill_port,
            kill_process,
            is_port_in_use,
            run_project_command,
            open_browser_url,
            load_projects,
            save_projects,
            update_tray_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
