import { LeftPane } from "@/components/LeftPane";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <LeftPane>{children}</LeftPane>;
}
