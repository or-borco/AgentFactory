// Icon barrel — all from @phosphor-icons/react v2
export {
  ArrowRight as ArrowRightIcon,
  ArrowLeft as ArrowLeftIcon,
  Envelope as MailIcon,
  Lock as LockIcon,
  Plus as PlusIcon,
  Users as UsersIcon,
  Gear as SettingsIcon,
  Chat as ChatIcon,
  PaperPlaneTilt as SendIcon,
  CaretDown as ChevronDownIcon,
  Check as CheckIcon,
  X as XIcon,
  Robot as BotIcon,
  Sparkle as SparklesIcon,
  Plugs as LinkIcon,
  User as UserIcon,
  SignOut as LogOutIcon,
  Warning as AlertIcon,
  ListChecks as TasksIcon,
  Pulse as ActivityIcon,
  Trash as TrashIcon,
} from "@phosphor-icons/react";

// Google brand icon kept as custom SVG
import type { SVGProps } from "react";
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
