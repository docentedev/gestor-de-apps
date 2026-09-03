import { IconPlus } from "../icons";
import type { Project } from "../types";

interface BtnAddServiceProps {
  openCreateService: (proj: Project) => void;
  proj: Project;
}

const BtnAddService = ({ openCreateService, proj }: BtnAddServiceProps) => {
  return (
    <button className="btn btn-action btn-add-service" onClick={() => openCreateService(proj)}>
      <IconPlus size={11} /> Servicio (ej: Back)
    </button>
  );
};

export default BtnAddService;
