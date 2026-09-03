import { IconPlus } from "../icons";

interface BtnAddTaskProps {
  label: string;
  onClick: () => void;
}

// Botón "+" genérico de la sección de tareas: se reusa tanto para "+ Tarea"
// como para "+ Grupo" (cada llamador decide la acción y la etiqueta).
const BtnAddTask = ({ onClick, label }: BtnAddTaskProps) => {
  return (
    <button className="btn btn-action btn-add-task" onClick={onClick}>
      <IconPlus size={11} /> {label}
    </button>
  );
};

export default BtnAddTask;
