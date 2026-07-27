import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function base(children: React.ReactNode, props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ArrowRightIcon = (p: IconProps) =>
  base(<path d="M5 12h14M13 6l6 6-6 6" />, p);

export const ArrowLeftIcon = (p: IconProps) =>
  base(<path d="M19 12H5M11 18l-6-6 6-6" />, p);

export const MailIcon = (p: IconProps) =>
  base(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>,
    p,
  );

export const LockIcon = (p: IconProps) =>
  base(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>,
    p,
  );

export const PlusIcon = (p: IconProps) => base(<path d="M12 5v14M5 12h14" />, p);

export const UsersIcon = (p: IconProps) =>
  base(
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.3a3.25 3.25 0 0 1 0 6.2M20 20a6.2 6.2 0 0 0-4.5-6" />
    </>,
    p,
  );

export const SettingsIcon = (p: IconProps) =>
  base(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>,
    p,
  );

export const ChatIcon = (p: IconProps) =>
  base(<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.4 8.5 8.5 0 0 1-4-1L3 20l1.1-3.3a8.4 8.4 0 0 1-1-4A8.38 8.38 0 0 1 11.5 4a8.5 8.5 0 0 1 8.5 8.5v-1Z" />, p);

export const SendIcon = (p: IconProps) =>
  base(<path d="m3 12 18-9-9 18-2-7-7-2Z" />, p);

export const ChevronDownIcon = (p: IconProps) => base(<path d="m6 9 6 6 6-6" />, p);

export const CheckIcon = (p: IconProps) => base(<path d="M20 6 9 17l-5-5" />, p);

export const XIcon = (p: IconProps) => base(<path d="M18 6 6 18M6 6l12 12" />, p);

export const BotIcon = (p: IconProps) =>
  base(
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 4h6" />
      <circle cx="9" cy="14" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.25" fill="currentColor" stroke="none" />
    </>,
    p,
  );

export const SparklesIcon = (p: IconProps) =>
  base(
    <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />,
    p,
  );

export const LinkIcon = (p: IconProps) =>
  base(
    <>
      <path d="M9 15 15 9" />
      <path d="M11 6l1.3-1.3a4 4 0 1 1 5.7 5.7L16 12" />
      <path d="M13 18l-1.3 1.3a4 4 0 1 1-5.7-5.7L8 12" />
    </>,
    p,
  );

export const AlertIcon = (p: IconProps) =>
  base(
    <>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </>,
    p,
  );

export const GoogleIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" {...p}>
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.85A10.99 10.99 0 0 0 12 23Z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.85Z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a10.99 10.99 0 0 0-9.82 6.05l3.66 2.85c.87-2.6 3.3-4.52 6.16-4.52Z"
    />
  </svg>
);
