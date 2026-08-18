import { createBrowserRouter, NavLink, Outlet, RouterProvider } from 'react-router';
import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  useIsMobile,
} from '@databricks/appkit-ui/react';
import { Menu } from 'lucide-react';
import { OverviewPage } from './pages/OverviewPage';
import { GovernancePage } from './pages/GovernancePage';
import { HygienePage } from './pages/HygienePage';
import { CostRoiPage } from './pages/CostRoiPage';
import { adminApi, type CurrentIdentity } from './lib/admin-api';
import { DEFAULT_FILTERS, type AdminFilters } from './lib/filters';
import type { AdminOutletContext } from './lib/outlet';
import type { DashboardSummary } from '../../shared/admin-insights';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

type NavLinkClassFn = (props: { isActive: boolean }) => string;

function NavLinks({
  className,
  linkClass,
  onClick,
}: {
  className?: string;
  linkClass: NavLinkClassFn;
  onClick?: () => void;
}) {
  return (
    <nav className={className}>
      <NavLink to="/" end className={linkClass} onClick={onClick}>
        Overview
      </NavLink>
      <NavLink to="/governance" className={linkClass} onClick={onClick}>
        Data governance
      </NavLink>
      <NavLink to="/hygiene" className={linkClass} onClick={onClick}>
        Resource hygiene
      </NavLink>
      <NavLink to="/cost" className={linkClass} onClick={onClick}>
        ROI
      </NavLink>
    </nav>
  );
}

function Layout() {
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [filters, setFilters] = useState<AdminFilters>(DEFAULT_FILTERS);
  const [identity, setIdentity] = useState<CurrentIdentity | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  useEffect(() => {
    void adminApi.whoami().then(setIdentity).catch(() => setIdentity(null));
    void adminApi.summary().then(setSummary).catch(() => setSummary(null));
  }, []);

  const outletContext: AdminOutletContext = { filters, setFilters, identity, summary };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b px-4 md:px-6 py-3 flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">Admin Insights</h1>
        <NavLinks className="hidden md:flex gap-1" linkClass={navLinkClass} />
        <div className="ml-auto flex items-center gap-2">
          {identity ? (
            <Badge variant="secondary">{identity.runtime.executionMode}</Badge>
          ) : null}
          <div className="md:hidden">
            <Sheet open={isMobile && mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)}>
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation</span>
              </Button>
              <SheetContent side="left">
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <NavLinks
                  className="flex flex-col gap-1"
                  linkClass={mobileNavLinkClass}
                  onClick={() => setMobileNavOpen(false)}
                />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main className="flex-1 p-4 md:p-6">
        <Outlet context={outletContext} />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/governance', element: <GovernancePage /> },
      { path: '/hygiene', element: <HygienePage /> },
      { path: '/cost', element: <CostRoiPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
