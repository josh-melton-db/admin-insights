import type { ReactNode } from 'react';

export function WorkspaceLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) {
    return <>{children}</>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  );
}
