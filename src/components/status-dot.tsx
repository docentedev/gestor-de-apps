interface StatusDotProps {
  running: boolean;
}

const StatusDot = ({ running }: StatusDotProps) => {
  return (
    <span
      className={`status-dot ${running ? "running" : ""}`}
      title={running ? "Corriendo" : "Detenido"}
    />
  );
};

export default StatusDot;
