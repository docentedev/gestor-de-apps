import { IconPlay, IconStop } from "../icons";
import type { Service } from "../types";
import StatusDot from "./status-dot";

interface ServiceChipMiniProps {
  service: Service;
  running: boolean;
  onSelect: (service: Service) => void;
  onRun: (service: Service) => void;
  onKill: (service: Service) => void;
}

const ServiceChipMini = ({
  service,
  running,
  onSelect,
  onRun,
  onKill,
}: ServiceChipMiniProps) => {
  return (
    <div
      className="service-chip-mini service-chip-compact"
      onClick={() => onSelect(service)}
      title={`${service.name} · :${service.port} · ${service.path} • ${service.command}`}
    >
      <span className="service-name">{service.name}</span>
      <StatusDot running={running} />
      <button
        className="btn btn-action btn-run btn-icon-only"
        onClick={(e) => {
          e.stopPropagation();
          onRun(service);
        }}
        disabled={running}
        title={running ? `"${service.name}" ya está corriendo` : `Iniciar "${service.name}"`}
      >
        <IconPlay size={11} />
      </button>
      <button
        className="btn btn-action btn-kill btn-icon-only"
        onClick={(e) => {
          e.stopPropagation();
          onKill(service);
        }}
        title={`Matar puerto ${service.port} ("${service.name}")`}
      >
        <IconStop size={11} />
      </button>
    </div>
  );
};

export default ServiceChipMini;
