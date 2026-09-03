import {
  IconGlobe,
  IconPencil,
  IconPlay,
  IconStop,
  IconTerminal,
  IconTrash,
} from "../icons";
import type { Project, Service, Task, TaskGroup } from "../types";
import StatusDot from "./status-dot";
import TaskChipCompact from "./task-chip-compact";
import TaskGroupChip from "./task-group-chip";
import BtnAddTask from "./btn-add-task";

interface ServiceCardProps {
  proj: Project;
  service: Service;
  running: boolean;
  runningTasks: Record<string, string>;
  onRun: (service: Service) => void;
  onKill: (service: Service) => void;
  onOpen: (service: Service) => void;
  onViewTerminal: (service: Service) => void;
  onEditService: (proj: Project, service: Service) => void;
  onDeleteService: (proj: Project, service: Service) => void;
  openCreateTask: (proj: Project, service: Service) => void;
  openEditTask: (proj: Project, service: Service, task: Task) => void;
  askDeleteTask: (proj: Project, service: Service, task: Task) => void;
  handleRunTask: (proj: Project, service: Service, task: Task) => void;
  stopTask: (service: Service, task: Task) => void;
  openCreateTaskGroup: (proj: Project, service: Service) => void;
  openEditTaskGroup: (proj: Project, service: Service, group: TaskGroup) => void;
  askDeleteTaskGroup: (proj: Project, service: Service, group: TaskGroup) => void;
  runTaskGroup: (service: Service, group: TaskGroup) => void;
}

// Card completa de un servicio (vista completa del proyecto): ruta,
// comando, puerto, acciones, sus tareas puntuales y sus grupos de tareas.
const ServiceCard = ({
  proj,
  service,
  running,
  runningTasks,
  onRun,
  onKill,
  onOpen,
  onViewTerminal,
  onEditService,
  onDeleteService,
  openCreateTask,
  openEditTask,
  askDeleteTask,
  handleRunTask,
  stopTask,
  openCreateTaskGroup,
  openEditTaskGroup,
  askDeleteTaskGroup,
  runTaskGroup,
}: ServiceCardProps) => {
  return (
    <div className="project-card">
      <div className="project-main">
        <div className="project-info">
          <span className="project-name">
            <StatusDot running={running} />
            {service.name}
          </span>
          <span className="project-path">{service.path}</span>
          <div className="project-details">
            <code>{service.command}</code> • Puerto: <strong>{service.port}</strong>
          </div>
        </div>

        {/* Botones sin etiqueta (solo icono + tooltip): con 6 acciones por
            servicio, el texto repetido sumaba ruido visual; el icono ya es
            suficientemente claro. */}
        <div className="project-actions">
          <button
            className="btn btn-action btn-run btn-icon-only"
            onClick={() => onRun(service)}
            disabled={running}
            title={running ? "Ya está corriendo" : "Iniciar"}
          >
            <IconPlay />
          </button>
          <button
            className="btn btn-action btn-kill btn-icon-only"
            onClick={() => onKill(service)}
            title={`Matar puerto ${service.port}`}
          >
            <IconStop />
          </button>
          <button
            className="btn btn-action btn-open btn-icon-only"
            onClick={() => onOpen(service)}
            title="Abrir en el navegador"
          >
            <IconGlobe />
          </button>
          <button
            className="btn btn-action btn-icon-only"
            onClick={() => onViewTerminal(service)}
            title="Ver terminal"
          >
            <IconTerminal />
          </button>
          <button
            className="btn btn-action btn-edit btn-icon-only"
            onClick={() => onEditService(proj, service)}
            title="Editar servicio"
          >
            <IconPencil />
          </button>
          <button
            className="btn btn-action btn-delete btn-icon-only"
            onClick={() => onDeleteService(proj, service)}
            title="Eliminar servicio"
          >
            <IconTrash />
          </button>
        </div>
      </div>

      {/* Tareas puntuales del servicio: comandos que inician y terminan
          solos (ej: npm run test, git commit -m "{{mensaje}}"). Si el
          comando trae placeholders {{param}}, al ejecutar se pide el valor
          antes de correrlo. */}
      <div className="project-tasks">
        <div className="task-list">
          {service.tasks.map((task) => (
            <TaskChipCompact
              key={task.id}
              task={task}
              service={service}
              proj={proj}
              runningTasks={runningTasks}
              stopTask={stopTask}
              handleRunTask={handleRunTask}
              openEditTask={openEditTask}
              askDeleteTask={askDeleteTask}
            />
          ))}
          <BtnAddTask onClick={() => openCreateTask(proj, service)} label="Tarea" />
        </div>
      </div>

      {/* Grupos: corren varias tareas del servicio en secuencia con un solo
          botón, deteniéndose si alguna termina con código distinto de cero. */}
      {service.taskGroups.length > 0 && (
        <div className="project-tasks">
          <div className="task-list">
            {service.taskGroups.map((group) => (
              <TaskGroupChip
                key={group.id}
                group={group}
                service={service}
                proj={proj}
                runTaskGroup={runTaskGroup}
                openEditTaskGroup={openEditTaskGroup}
                askDeleteTaskGroup={askDeleteTaskGroup}
              />
            ))}
            <BtnAddTask onClick={() => openCreateTaskGroup(proj, service)} label="Grupo" />
          </div>
        </div>
      )}
      {service.taskGroups.length === 0 && (
        <BtnAddTask
          onClick={() => openCreateTaskGroup(proj, service)}
          label="Grupo de tareas"
        />
      )}
    </div>
  );
};

export default ServiceCard;
