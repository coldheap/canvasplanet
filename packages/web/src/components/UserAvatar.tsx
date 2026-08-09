import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";

export function avatarUrl(userId: number, revision: string): string {
  return `/avatars/${userId}/${revision}.webp`;
}

export function UserAvatar({
  userId,
  name,
  revision,
  size = 20,
  previewUrl,
  label,
  className = "",
}: {
  userId: number;
  name: string;
  revision: string | null;
  size?: number;
  previewUrl?: string | null;
  label?: string;
  className?: string;
}) {
  const src = previewUrl ?? (revision ? avatarUrl(userId, revision) : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  return (
    <span
      className={`wc-user-avatar ${className}`.trim()}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      {src && !failed ? (
        <img src={src} alt="" loading={size <= 24 ? "lazy" : "eager"} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <UserRound size={Math.max(12, Math.round(size * 0.58))} strokeWidth={2} aria-hidden="true" />
      )}
    </span>
  );
}
