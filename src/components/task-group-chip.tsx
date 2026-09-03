import { IconPlay, IconPencil, IconTrash } from "../icons";
import type { Project, Service, TaskGroup } from "../types";

interface TaskGroupChipProps {
  group: TaskGroup;
  service: Service;
  proj: Project;
  runTaskGroup: (service: Service, group: TaskGroup) => void;
  openEditTaskGroup: (proj: Project, service: Service, group: TaskGroup) => void;
  askDeleteTaskGroup: (proj: Project, service: Service, group: TaskGroup) => void;
}

const TaskGroupChip = ({
  group,
  service,
  proj,
  runTaskGroup,
  openEditTaskGroup,
  askDeleteTaskGroup,
}: TaskGroupChipProps) => {
  return (
    <div className="task-chip">
      <span className="task-name">{group.name}</span>
      <code className="task-command">{group.taskIds.length} tarea(s)</code>
      <button
        className="btn btn-action btn-run btn-icon-only"
        onClick={() => runTaskGroup(service, group)}
        title={`Ejecutar grupo "${group.name}"`}
      >
        <IconPlay size={11} />
      </button>
      <button
        className="btn btn-action btn-edit btn-icon-only"
        onClick={() => openEditTaskGroup(proj, service, group)}
        title={`Editar grupo "${group.name}"`}
      >
        <IconPencil size={11} />
      </button>
      <button
        className="btn btn-action btn-delete btn-icon-only"
        onClick={() => askDeleteTaskGroup(proj, service, group)}
        title={`Eliminar grupo "${group.name}"`}
      >
        <IconTrash size={11} />
      </button>
    </div>
  );
};

export default TaskGroupChip;
