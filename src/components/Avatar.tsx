import { initials } from "../lib/format";

export function Avatar({
  name,
  color,
  size = 48,
  online,
  className = "",
}: {
  name: string;
  color: string;
  size?: number;
  online?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full select-none items-center justify-center rounded-[28%] font-bold text-white shadow-sm"
        style={{
          backgroundColor: color,
          fontSize: size * 0.36,
          textShadow: "0 1px 2px rgba(0,0,0,0.18)",
        }}
      >
        {initials(name)}
      </div>
      {online !== undefined && (
        <span
          className="absolute -bottom-0.5 -end-0.5 block rounded-full border-2 border-dusk-50"
          style={{
            width: size * 0.28,
            height: size * 0.28,
            backgroundColor: online ? "#5d9c73" : "#c7b7a0",
          }}
        />
      )}
    </div>
  );
}