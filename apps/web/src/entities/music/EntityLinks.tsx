import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { MusicPlatform, Song, SongArtist } from "#shared";

export function ArtistLinks({
  platform,
  artists,
  fallbackText,
  primaryArtistId,
  className = "",
  linkClassName = "hover:text-[var(--tv-text)] hover:underline",
  onNavigate,
}: {
  platform: MusicPlatform;
  artists?: SongArtist[];
  fallbackText: string;
  primaryArtistId?: string;
  className?: string;
  linkClassName?: string;
  onNavigate?: () => void;
}) {
  const list: SongArtist[] =
    artists && artists.length > 0 ? artists : [{ id: primaryArtistId, name: fallbackText || "未知歌手" }];

  return (
    <span className={className}>
      {list.map((artist, index) => (
        <Fragment key={`${artist.id ?? artist.name}-${index}`}>
          {index > 0 && <span className="opacity-60"> / </span>}
          {artist.id ? (
            <Link
              to={`/artist/${platform}/${encodeURIComponent(artist.id)}`}
              onClick={(e) => {
                e.stopPropagation();
                onNavigate?.();
              }}
              className={linkClassName}
            >
              {artist.name}
            </Link>
          ) : (
            <span>{artist.name}</span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

export function AlbumLink({
  song,
  className = "hover:text-[var(--tv-text)] hover:underline",
  onNavigate,
}: {
  song: Pick<Song, "platform" | "album" | "albumId">;
  className?: string;
  onNavigate?: () => void;
}) {
  const title = song.album || "—";
  if (!song.albumId || !song.album) {
    return <span>{title}</span>;
  }

  return (
    <Link
      to={`/album/${song.platform}/${encodeURIComponent(song.albumId)}`}
      onClick={(e) => {
        e.stopPropagation();
        onNavigate?.();
      }}
      className={className}
    >
      {title}
    </Link>
  );
}
