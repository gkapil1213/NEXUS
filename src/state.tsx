/**
 * NEXUS Phase 1 — application state.
 * Boots the real kernel, manages the authenticated session and provides
 * routing + toasts. No business logic lives here.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createAuthApi, NexusKernel, type AuthApi, type KernelServices } from "./core/kernel";
import { CONFIG } from "./core/config";
import type { BootStep, NexusEvent, PublicUser } from "./core/types";

export type RouteName = "dashboard" | "projects" | "executions" | "audit" | "control";

interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  title: string;
  detail?: string;
}

interface NexusState {
  booting: boolean;
  bootSteps: BootStep[];
  bootError: string | null;
  retryBoot: () => void;

  kernel: NexusKernel | null;
  services: KernelServices | null;
  auth: AuthApi | null;

  user: PublicUser | null;
  initializing: boolean; // no users exist yet
  login: (email: string, password: string) => Promise<void>;
  bootstrap: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;

  route: RouteName;
  navigate: (r: RouteName) => void;

  toasts: Toast[];
  toast: (kind: Toast["kind"], title: string, detail?: string) => void;
  dismissToast: (id: number) => void;

  liveEvents: NexusEvent[];
}

const Ctx = createContext<NexusState | null>(null);

const TOKEN_KEY = "nexus.session.token";

export function useNexus(): NexusState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNexus outside provider");
  return v;
}

export function NexusProvider({ children }: { children: ReactNode }) {
  const [booting, setBooting] = useState(true);
  const [bootSteps, setBootSteps] = useState<BootStep[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);

  const [kernel, setKernel] = useState<NexusKernel | null>(null);
  const [services, setServices] = useState<KernelServices | null>(null);
  const [auth, setAuth] = useState<AuthApi | null>(null);

  const [user, setUser] = useState<PublicUser | null>(null);
  const [initializing, setInitializing] = useState(false);

  const [route, setRoute] = useState<RouteName>("dashboard");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [liveEvents, setLiveEvents] = useState<NexusEvent[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast["kind"], title: string, detail?: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, kind, title, detail }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const runBoot = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    const k = new NexusKernel();
    // Animate the real boot steps.
    const mirror = () => setBootSteps(k.steps.map((s) => ({ ...s })));
    mirror();
    const iv = window.setInterval(mirror, 90);
    try {
      const svc = await k.boot();
      mirror();
      setKernel(k);
      setServices(svc);
      const authApi = createAuthApi(svc);
      setAuth(authApi);
      setLiveEvents(await svc.events.list(12));
      svc.events.on((e) => setLiveEvents((prev) => [e, ...prev].slice(0, 12)));

      // Session restore / first-run detection.
      const stored = localStorage.getItem(TOKEN_KEY);
      if (stored) {
        try {
          const { user: u } = await authApi.validate(stored);
          setUser(u);
        } catch {
          localStorage.removeItem(TOKEN_KEY);
        }
      }
      if (!(await authApi.hasUsers())) setInitializing(true);
    } catch (e) {
      setBootError((e as Error).message);
    } finally {
      window.clearInterval(iv);
      mirror();
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    void runBoot();
  }, [runBoot]);

  const login = useCallback(
    async (email: string, password: string) => {
      if (!auth) throw new Error("kernel not ready");
      const { user: u, session } = await auth.login(email, password);
      localStorage.setItem(TOKEN_KEY, session.token);
      setUser(u);
      setInitializing(false);
    },
    [auth],
  );

  const bootstrap = useCallback(
    async (email: string, name: string, password: string) => {
      if (!auth) throw new Error("kernel not ready");
      const { user: u, session } = await auth.bootstrapFirstUser(email, name, password);
      localStorage.setItem(TOKEN_KEY, session.token);
      setUser(u);
      setInitializing(false);
    },
    [auth],
  );

  const logout = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && auth) {
      await auth.logout(token).catch(() => undefined);
    }
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }, [auth]);

  const value = useMemo<NexusState>(
    () => ({
      booting,
      bootSteps,
      bootError,
      retryBoot: () => void runBoot(),
      kernel,
      services,
      auth,
      user,
      initializing,
      login,
      bootstrap,
      logout,
      route,
      navigate: setRoute,
      toasts,
      toast,
      dismissToast,
      liveEvents,
    }),
    [booting, bootSteps, bootError, runBoot, kernel, services, auth, user, initializing, login, bootstrap, logout, route, toasts, toast, dismissToast, liveEvents],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { CONFIG };
