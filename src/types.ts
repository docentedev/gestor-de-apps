// Tipos de dominio compartidos entre App.tsx y los componentes de
// src/components/. Viven en su propio módulo (en vez de exportarse desde
// App.tsx) para que los componentes los importen sin depender del archivo
// principal.

export interface EnvVar {
  key: string;
  value: string;
}

export interface Task {
  id: string;
  name: string;
  command: string;
  env: EnvVar[];
}

// Grupo de tareas ya existentes del mismo servicio, para correrlas en
// secuencia con un solo botón (se detiene si alguna falla).
export interface TaskGroup {
  id: string;
  name: string;
  taskIds: string[];
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
  env: EnvVar[];
  taskGroups: TaskGroup[];
}

// El proyecto es solo un contenedor organizativo (ej: "MiApp") que agrupa
// los servicios que la componen (ej: Front y Back).
export interface Project {
  id: string;
  name: string;
  services: Service[];
}
