/**
 * A real, deterministic sample workspace used by the console. It is a genuine
 * in-browser TypeScript project that the pipeline modules actually build, test
 * and scan. Scenario presets inject a real defect so the failure/block paths
 * can be observed live — nothing is faked.
 */

export type Scenario = "clean" | "secret" | "syntax";

export const SCENARIOS: { id: Scenario; label: string; hint: string }[] = [
  { id: "clean", label: "Clean build", hint: "full source chain passes; Docker reports honestly blocked" },
  { id: "secret", label: "Inject a leaked secret", hint: "security review fails on a real credential pattern" },
  { id: "syntax", label: "Break the syntax", hint: "build fails on unbalanced braces" },
];

const PACKAGE_JSON = `{
  "name": "hotel-booking-api",
  "version": "0.1.0",
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "nexus-spec"
  },
  "dependencies": {
    "fastify": "4.26.0",
    "zod": "3.22.4"
  },
  "devDependencies": {
    "typescript": "5.4.2"
  }
}
`;

const INDEX_TS = `import { searchHotels } from "./search";
import { createBooking, cancelBooking } from "./booking";

export function boot() {
  const results = searchHotels({ destination: "Lisbon", checkIn: "2026-07-01", checkOut: "2026-07-05" });
  const booking = createBooking({ hotelId: results[0]?.id ?? "h-1", guests: 2 });
  return { results: results.length, booking };
}
`;

const SEARCH_TS = `export interface HotelQuery {
  destination: string;
  checkIn: string;
  checkOut: string;
}

export function searchHotels(q: HotelQuery) {
  const hotels = [
    { id: "h-1", name: "Atlântico Grand", city: q.destination, price: 148 },
    { id: "h-2", name: "Baixa Boutique", city: q.destination, price: 96 },
    { id: "h-3", name: "Tejo Riverside", city: q.destination, price: 172 },
  ];
  return hotels.filter((h) => h.city === q.destination);
}
`;

const BOOKING_TS = `export interface BookingInput {
  hotelId: string;
  guests: number;
}

export function createBooking(input: BookingInput) {
  return {
    id: "bk-" + Math.random().toString(36).slice(2, 8),
    hotelId: input.hotelId,
    guests: input.guests,
    status: "confirmed",
  };
}

export function cancelBooking(id: string) {
  return { id, status: "cancelled" };
}
`;

const TESTS_JSON = `{
  "suite": "hotel-booking-spec",
  "assertions": [
    { "type": "file_exists", "path": "dist/bundle.js" },
    { "type": "contains", "path": "dist/bundle.js", "needle": "__NEXUS_BUNDLE__" },
    { "type": "contains", "path": "dist/bundle.js", "needle": "src/index.ts" },
    { "type": "file_exists", "path": "dist/build-manifest.json" },
    { "type": "min_size", "path": "dist/bundle.js", "bytes": 128 }
  ]
}
`;

const DOCKERFILE = `# Multi-stage build — the artifact the Docker stage would consume.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/bundle.js"]
`;

const SECRET_FILE = `// Do NOT ship this — injected by the failure scenario.
export const api_key = "AKIAIOSFODNN7EXAMPLE";
export const DB_PASSWORD = "hunter2-super-secret";
`;

export function buildWorkspace(scenario: Scenario): Record<string, string> {
  const ws: Record<string, string> = {
    "package.json": PACKAGE_JSON,
    "src/index.ts": INDEX_TS,
    "src/search.ts": SEARCH_TS,
    "src/booking.ts": BOOKING_TS,
    "nexus.tests.json": TESTS_JSON,
    "Dockerfile": DOCKERFILE,
  };
  if (scenario === "secret") {
    ws["src/config.ts"] = SECRET_FILE;
  }
  if (scenario === "syntax") {
    // Unbalanced braces — the builder's structural check will reject it.
    ws["src/booking.ts"] = BOOKING_TS.replace("export function cancelBooking(id: string) {", "export function cancelBooking(id: string) {");
    ws["src/broken.ts"] = "export function broken() {\n  return { ok: true ;\n}\n";
  }
  return ws;
}

export const DEFAULT_PROMPT =
  "Build a production hotel-booking marketplace for web and mobile: registration and sign-in, hotel search by destination and dates, availability, filters and sorting, hotel and room details, bookings with confirmation, policy-driven cancellation, notifications, and customer / provider / admin dashboards with role-based access.";

export const WORKSPACE_FILES = ["package.json", "src/index.ts", "src/search.ts", "src/booking.ts", "nexus.tests.json", "Dockerfile"];
