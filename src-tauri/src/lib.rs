use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, serde::Serialize)]
struct ProcessOutput {
    id: String,
    stream: String, // "stdout" | "stderr" | "exit" | "error"
    line: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct TaskConfig {
    id: String,
    name: String,
    command: String,
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

    if let Some(stdout) = child.stdout.take() {
        let app_handle = app.clone();
        let id_clone = id.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                let _ = app_handle.emit(
                    "project-log",
                    ProcessOutput { id: id_clone.clone(), stream: "stdout".into(), line },
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
                    ProcessOutput { id: id_clone.clone(), stream: "stderr".into(), line },
                );
            }
        });
    }

    thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let _ = app.emit(
                "project-log",
                ProcessOutput {
                    id,
                    stream: "exit".into(),
                    line: format!("Proceso finalizado (código {:?})", status.code()),
                },
            );
        }
    });

    Ok(format!("Ejecutando '{}' en {}", command, path))
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
        .invoke_handler(tauri::generate_handler![
            greet,
            kill_port,
            run_project_command,
            open_browser_url,
            load_projects,
            save_projects
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
