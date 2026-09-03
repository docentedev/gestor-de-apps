// Set de iconos propio (trazo fino, estilo SF Symbols/Lucide) para
// reemplazar los emojis de la UI por algo más sobrio y consistente. Todos
// usan currentColor, así que heredan el color del botón/texto que los
// contiene (incluyendo los estados :hover ya definidos en App.css).

interface IconProps {
  className?: string;
  size?: number;
}

const box = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  "aria-hidden": true as const,
});

export function IconPlay({ className, size = 13 }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <path fill="currentColor" d="M8 5v14l11-7z" />
    </svg>
  );
}

export function IconStop({ className, size = 13 }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}

export function IconGlobe({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 4 5.5 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.5-4-9s1.5-6.5 4-9z" />
    </svg>
  );
}

export function IconTerminal({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

export function IconPencil({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export function IconTrash({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    </svg>
  );
}

export function IconPlus({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconChevronRight({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function IconChevronDown({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconAlertTriangle({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3l9 16H3l9-16z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

export function IconXCircle({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </svg>
  );
}

export function IconCheckCircle({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 5-5" />
    </svg>
  );
}

export function IconDot({ className, size = 8 }: IconProps) {
  return (
    <svg {...box(size)} className={className}>
      <circle cx="12" cy="12" r="6" fill="currentColor" />
    </svg>
  );
}

export function IconStopCircle({ className, size = 13 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconFolder({ className, size = 16 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

export function IconCpu({ className, size = 16 }: IconProps) {
  return (
    <svg
      {...box(size)}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </svg>
  );
}
