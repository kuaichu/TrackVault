import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Apple SF Symbols-inspired media & audio glyphs with harmonious soft-rounded geometry
 * and consistent visual weight (eliminating thin-wireframe vs sharp-polygon clashes).
 */
export function SfPlayFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7 5.24C7 3.98 8.38 3.21 9.46 3.87L19.82 10.63C20.85 11.3 20.85 12.7 19.82 13.37L9.46 20.13C8.38 20.79 7 20.02 7 18.76V5.24Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SfPauseFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect x="5.75" y="4" width="4.5" height="16" rx="2.1" fill="currentColor" />
      <rect x="13.75" y="4" width="4.5" height="16" rx="2.1" fill="currentColor" />
    </svg>
  );
}

export function SfForwardFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M2.75 6.35C2.75 5.32 3.88 4.69 4.76 5.24L11.85 10.88C12.56 11.44 12.56 12.56 11.85 13.12L4.76 18.76C3.88 19.31 2.75 18.68 2.75 17.65V6.35Z"
        fill="currentColor"
      />
      <path
        d="M12 6.35C12 5.32 13.13 4.69 14.01 5.24L21.1 10.88C21.81 11.44 21.81 12.56 21.1 13.12L14.01 18.76C13.13 19.31 12 18.68 12 17.65V6.35Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SfBackwardFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <g transform="translate(24 0) scale(-1 1)">
        <path
          d="M2.75 6.35C2.75 5.32 3.88 4.69 4.76 5.24L11.85 10.88C12.56 11.44 12.56 12.56 11.85 13.12L4.76 18.76C3.88 19.31 2.75 18.68 2.75 17.65V6.35Z"
          fill="currentColor"
        />
        <path
          d="M12 6.35C12 5.32 13.13 4.69 14.01 5.24L21.1 10.88C21.81 11.44 21.81 12.56 21.1 13.12L14.01 18.76C13.13 19.31 12 18.68 12 17.65V6.35Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export function SfRepeat(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.25 10.5V9.25C4.25 7.45 5.7 6 7.5 6H17.25"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
      />
      <path
        d="M16.1 3.35C16.1 2.82 16.71 2.52 17.13 2.84L20.38 5.34C20.72 5.6 20.72 6.12 20.38 6.38L17.13 8.88C16.71 9.2 16.1 8.9 16.1 8.37V3.35Z"
        fill="currentColor"
      />
      <path
        d="M19.75 13.5V14.75C19.75 16.55 18.3 18 16.5 18H6.75"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
      />
      <path
        d="M7.9 20.65C7.9 21.18 7.29 21.48 6.87 21.16L3.62 18.66C3.28 18.4 3.28 17.88 3.62 17.62L6.87 15.12C7.29 14.8 7.9 15.1 7.9 15.63V20.65Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SfRepeatOne(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.25 10.5V9.25C4.25 7.45 5.7 6 7.5 6H17.25"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
      />
      <path
        d="M16.1 3.35C16.1 2.82 16.71 2.52 17.13 2.84L20.38 5.34C20.72 5.6 20.72 6.12 20.38 6.38L17.13 8.88C16.71 9.2 16.1 8.9 16.1 8.37V3.35Z"
        fill="currentColor"
      />
      <path
        d="M19.75 13.5V14.75C19.75 16.55 18.3 18 16.5 18H6.75"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
      />
      <path
        d="M7.9 20.65C7.9 21.18 7.29 21.48 6.87 21.16L3.62 18.66C3.28 18.4 3.28 17.88 3.62 17.62L6.87 15.12C7.29 14.8 7.9 15.1 7.9 15.63V20.65Z"
        fill="currentColor"
      />
      <path
        d="M12.35 9.6V14.4M12.35 9.6L10.85 10.7"
        stroke="currentColor"
        strokeWidth="2.05"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SfShuffle(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M3.75 7.25H6.4C7.72 7.25 8.95 7.92 9.67 9.03L14.33 14.97C15.05 16.08 16.28 16.75 17.6 16.75H18.25"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
      />
      <path
        d="M3.75 16.75H6.4C7.72 16.75 8.95 16.08 9.67 14.97L14.33 9.03C15.05 7.92 16.28 7.25 17.6 7.25H18.25"
        stroke="currentColor"
        strokeWidth="2.15"
        strokeLinecap="round"
      />
      <path
        d="M17.1 4.65C17.1 4.13 17.7 3.83 18.12 4.15L21.12 6.45C21.45 6.7 21.45 7.2 21.12 7.45L18.12 9.75C17.7 10.07 17.1 9.77 17.1 9.25V4.65Z"
        fill="currentColor"
      />
      <path
        d="M17.1 14.75C17.1 14.23 17.7 13.93 18.12 14.25L21.12 16.55C21.45 16.8 21.45 17.3 21.12 17.55L18.12 19.85C17.7 20.17 17.1 19.87 17.1 19.35V14.75Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SfSpeakerMinFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7.25 9.25H10.35L14.9 5.35C15.73 4.64 17 5.23 17 6.32V17.68C17 18.77 15.73 19.36 14.9 18.65L10.35 14.75H7.25C6.28 14.75 5.5 13.97 5.5 13V11C5.5 10.03 6.28 9.25 7.25 9.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SfSpeakerMaxFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.25 9.25H7.35L11.9 5.35C12.73 4.64 14 5.23 14 6.32V17.68C14 18.77 12.73 19.36 11.9 18.65L7.35 14.75H4.25C3.28 14.75 2.5 13.97 2.5 13V11C2.5 10.03 3.28 9.25 4.25 9.25Z"
        fill="currentColor"
      />
      <path
        d="M16.85 9.2C18.3 10.7 18.3 13.3 16.85 14.8"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M19.55 6.65C22.3 9.55 22.3 14.45 19.55 17.35"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SfSpeakerXmarkFill(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4.25 9.25H7.35L11.9 5.35C12.73 4.64 14 5.23 14 6.32V17.68C14 18.77 12.73 19.36 11.9 18.65L7.35 14.75H4.25C3.28 14.75 2.5 13.97 2.5 13V11C2.5 10.03 3.28 9.25 4.25 9.25Z"
        fill="currentColor"
      />
      <path
        d="M17.25 9.5L21.5 14.5M21.5 9.5L17.25 14.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SfPlusCircle(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="2.1" />
      <path d="M12 8.4V15.6M8.4 12H15.6" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

export function SfHeart(props: IconProps & { filled?: boolean }) {
  const { filled = false, ...rest } = props;
  const heartPath =
    "M12 20.15C11.68 20.15 11.37 20.04 11.11 19.84C7.18 16.79 3.25 13.38 3.25 9.15C3.25 6.32 5.45 4.25 8.12 4.25C9.73 4.25 11.12 5.04 12 6.26C12.88 5.04 14.27 4.25 15.88 4.25C18.55 4.25 20.75 6.32 20.75 9.15C20.75 13.38 16.82 16.79 12.89 19.84C12.63 20.04 12.32 20.15 12 20.15Z";
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path
        d={heartPath}
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
        strokeWidth={filled ? undefined : "2.1"}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Apple Music signature rounded-card quote.bubble lyrics icon (distinct from oval comment bubble) */
export function SfLyricsBubble(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M6.5 4.25H17.5C19.43 4.25 21 5.82 21 7.75V14.75C21 16.68 19.43 18.25 17.5 18.25H11.1L7.35 20.82C6.75 21.23 5.95 20.78 5.98 20.06L6.06 18.21C4.32 17.99 3 16.53 3 14.75V7.75C3 5.82 4.57 4.25 6.5 4.25Z"
        stroke="currentColor"
        strokeWidth="1.95"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.65 9.15C8.74 9.15 8.05 9.8 8.05 10.65C8.05 11.44 8.66 12.02 9.44 12.02C9.68 12.02 9.91 11.95 10.1 11.85C9.97 12.84 9.31 13.52 8.48 13.88"
        stroke="currentColor"
        strokeWidth="2.05"
        strokeLinecap="round"
      />
      <path
        d="M14.95 9.15C14.04 9.15 13.35 9.8 13.35 10.65C13.35 11.44 13.96 12.02 14.74 12.02C14.98 12.02 15.21 11.95 15.4 11.85C15.27 12.84 14.61 13.52 13.78 13.88"
        stroke="currentColor"
        strokeWidth="2.05"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Rounded speech bubble with text lines for song comments */
export function SfCommentBubble(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7.2 18.6L4.2 20.2C3.66 20.49 3.05 20.01 3.19 19.41L3.75 16.9C2.96 15.65 2.5 14.18 2.5 12.55C2.5 7.95 6.72 4.25 12 4.25C17.28 4.25 21.5 7.95 21.5 12.55C21.5 17.15 17.28 20.85 12 20.85C10.25 20.85 8.61 20.43 7.2 19.7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.25 11.15H15.75M8.25 14.35H13.25"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Apple Music "Suggest Less" / FM Dislike slash-circle icon */
export function SfSlashCircle(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.75" stroke="currentColor" strokeWidth="2.05" />
      <path d="M6.05 6.05L17.95 17.95" stroke="currentColor" strokeWidth="2.05" strokeLinecap="round" />
    </svg>
  );
}

/** Apple Music playing-next / queue list icon */
export function SfQueueList(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="4.5" cy="7" r="1.35" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1.35" fill="currentColor" />
      <circle cx="4.5" cy="17" r="1.35" fill="currentColor" />
      <path
        d="M8.5 7H19.75M8.5 12H19.75M8.5 17H19.75"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}
