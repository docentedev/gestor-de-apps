import { IconStop, IconPlay, IconPencil, IconTrash } from "../icons";
import type { Project, Service, Task } from "../types";

interface TaskChipCompactProps {
  task: Task;
  service: Service;
  proj: Project;
  runningTasks: Record<string, string>;
  stopTask: (service: Service, task: Task) => void;
  handleRunTask: (proj: Project, service: Service, task: Task) => void;
  openEditTask: (proj: Project, service: Service, task: Task) => void;
  askDeleteTask: (proj: Project, service: Service, task: Task) => void;
}

const TaskChipCompact = ({
  task,
  service,
  proj,
  runningTasks,
  stopTask,
  handleRunTask,
  openEditTask,
  askDeleteTask,
}: TaskChipCompactProps) => {
  return (
    <div className="task-chip task-chip-compact" title={`${task.name}: ${task.command}`}>
      <span className="service-name">{task.name}</span>
      {runningTasks[task.id] ? (
        <button
          className="btn btn-action btn-kill btn-icon-only"
          onClick={() => stopTask(service, task)}
          title={`Detener "${task.name}"`}
        >
          <IconStop size={11} />
        </button>
      ) : (
        <button
          className="btn btn-action btn-run btn-icon-only"
          onClick={() => handleRunTask(proj, service, task)}
          title={`Ejecutar "${task.name}": ${task.command}`}
        >
          <IconPlay size={11} />
        </button>
      )}
      <button
        className="btn btn-action btn-edit btn-icon-only"
        onClick={() => openEditTask(proj, service, task)}
        title={`Editar "${task.name}"`}
      >
        <IconPencil size={11} />
      </button>
      <button
        className="btn btn-action btn-delete btn-icon-only"
        onClick={() => askDeleteTask(proj, service, task)}
        title={`Eliminar "${task.name}"`}
      >
        <IconTrash size={11} />
      </button>
    </div>
  );
};

export default TaskChipCompact;
