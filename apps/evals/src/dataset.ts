export type EvalTier = "easy" | "medium" | "hard";

export interface EvalCase {
    id: string;
    tier: EvalTier;
    prompt: string;
    // Post-build assertions:
    //  - Plain string          -> grep across all src/**/*.{tsx,ts,jsx,js}
    //  - "file:<path>"         -> file must exist (relative to project root)
    //  - "dep:<name>"          -> dependency present in package.json
    //  - "ast:..."             -> structural AST assertion (see src/ast.ts)
    expectedFeatures: string[];
    maxDurationMs?: number;
    maxFixAttempts?: number;
    /** Overlay files from apps/evals/fixtures/<name> after seeding the template. */
    fixture?: string;
}

export const EVAL_CASES: EvalCase[] = [
    // ── Easy ──────────────────────────────────────────────
    {
        id: "counter-basic",
        tier: "easy",
        prompt:
            "Create a simple counter app with a number display and two buttons: one to increment and one to decrement the count. The count should start at 0.",
        expectedFeatures: ["useState", "setCount", "button"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "todo-basic",
        tier: "easy",
        prompt:
            "Create a todo list app. Users should be able to type a task in an input field, add it to a list, mark tasks as complete (strikethrough), and delete tasks.",
        expectedFeatures: ["useState", "input", "todo", "delete", "file:src/App.jsx"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "landing-page",
        tier: "easy",
        prompt:
            "Create a landing page for a SaaS product called 'Nimbus'. Include a hero section with headline and CTA button, a features section with 3 feature cards, testimonials section with 2 quotes, and a footer with links.",
        expectedFeatures: ["Nimbus", "hero", "feature", "testimonial", "footer"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },

    // ── Medium ────────────────────────────────────────────
    {
        id: "dashboard-cards",
        tier: "medium",
        prompt:
            "Build an admin dashboard with a top stats row showing 4 metric cards (users, revenue, orders, conversion rate). Below that, add a recent activity table with columns: User, Action, Date, Status. Use mock data.",
        expectedFeatures: ["dashboard", "card", "table", "mock", "users", "revenue"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "weather-display",
        tier: "medium",
        prompt:
            "Create a weather app UI. It should have a search bar at the top to enter a city name, display the current weather (temperature, condition, humidity, wind speed) as a prominent card, and show a 5-day forecast row below with mock data.",
        expectedFeatures: ["search", "temperature", "humidity", "forecast", "mock"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "multi-page-nav",
        tier: "medium",
        prompt:
            "Create a multi-page app with react-router. Pages: Home, About, Contact. A persistent navigation bar at the top with links to all pages. The home page should have a welcome message, the about page should have team info, and the contact page should have a form with name, email, and message fields.",
        expectedFeatures: [
            "ast:import:react-router",
            "ast:jsx:Route",
            "About",
            "Contact",
            "nav",
            "form",
        ],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },

    // ── Hard ──────────────────────────────────────────────
    {
        id: "kanban-board",
        tier: "hard",
        prompt:
            "Build a Kanban board with 3 columns: To Do, In Progress, Done. Users can add new cards to any column, and cards should show a title and an optional description. Include a button on each card to move it left or right between columns.",
        expectedFeatures: ["kanban", "column", "To Do", "In Progress", "Done", "card"],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },
    {
        id: "crud-contacts",
        tier: "hard",
        prompt:
            "Create a contacts management app. A form at the top to add a new contact (name, email, phone). Below, a table listing all contacts with Edit and Delete buttons per row. Editing should populate the form. All state managed in-memory.",
        expectedFeatures: ["useState", "table", "edit", "delete", "form", "email", "phone"],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },
    {
        id: "analytics-charts",
        tier: "hard",
        prompt:
            "Build an analytics dashboard with two charts: a bar chart showing monthly revenue (Jan–Jun) and a line chart showing user signups over the same period. Use recharts library. Include a summary row below with total revenue, total signups, and growth percentage.",
        expectedFeatures: [
            "ast:import:recharts",
            "ast:jsx:BarChart",
            "ast:jsx:LineChart",
            "dep:recharts",
            "revenue",
        ],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },
    {
        id: "blog-crud",
        tier: "hard",
        prompt:
            "Create a simple blog platform with react-router. Pages: PostList (shows all posts as cards with title and excerpt), PostDetail (full content of a single post), CreatePost (form with title, content textarea, and submit button). State managed in-memory with useState.",
        expectedFeatures: [
            "ast:import:react-router",
            "ast:jsx:Route",
            "ast:hook:useState",
            "textarea",
            "post",
            "form",
        ],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },
    {
        id: "product-grid",
        tier: "hard",
        prompt:
            "Build an e-commerce product grid page. Show 6 product cards in a responsive grid (2 or 3 columns). Each card has an image placeholder, product name, price, and an Add to Cart button. Include a simple cart summary at the top showing total items and total price.",
        expectedFeatures: ["grid", "cart", "price", "button", "product", "total"],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },
    {
        id: "recipe-finder",
        tier: "hard",
        prompt:
            "Create a recipe finder app. A search bar filters recipes by name. Show a grid of recipe cards, each with a name, cuisine tag, cook time, and a brief description. Include filter buttons for cuisine types (Italian, Mexican, Asian). Clicking a card expands to show ingredients and steps.",
        expectedFeatures: ["search", "filter", "recipe", "ingredients", "useState", "cuisine"],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 4,
    },

    // ── Existing-app edits (ReAct incremental modification) ──
    {
        id: "edit-existing-app",
        tier: "medium",
        fixture: "existing-todo",
        prompt:
            "This project already has a working todo list. Add an optional due-date field to each task and show it next to the task text. Do not replace the whole app with a Hello World template.",
        expectedFeatures: ["due", "todo", "useState", "file:src/App.jsx"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "add-page-to-existing-router",
        tier: "medium",
        fixture: "existing-nav",
        prompt:
            "This app already has a Home view and a nav link. Add an About page with team info and a nav link to it. Prefer react-router if you add real routes; keep the existing Home welcome message.",
        expectedFeatures: ["About", "Home", "nav", "Welcome"],
        maxDurationMs: 12 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "add-component-using-existing-library",
        tier: "easy",
        fixture: "existing-todo",
        prompt:
            "Keep the existing todo list. Add a Card from the existing shadcn/ui Card component (@/components/ui/card) around the list. Do not add a new CSS framework.",
        expectedFeatures: ["Card", "todo", "file:src/components/ui/card.jsx"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "modify-existing-component",
        tier: "easy",
        fixture: "existing-counter",
        prompt:
            "The Counter component currently shows a static Count: 0 button. Make it a real counter with increment using useState. Keep the Counter component rather than deleting it.",
        expectedFeatures: ["useState", "Counter", "button"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
    {
        id: "preserve-existing-functionality",
        tier: "medium",
        fixture: "existing-todo",
        prompt:
            "Keep add and delete for todos working. Also add a completed checkbox that strikethroughs the task text when checked.",
        expectedFeatures: ["delete", "todo", "strikethrough", "useState"],
        maxDurationMs: 10 * 60_000,
        maxFixAttempts: 3,
    },
];

export function selectCases(options: { filter?: string; tier?: EvalTier }): EvalCase[] {
    return EVAL_CASES.filter((c) => {
        if (options.filter && !c.id.includes(options.filter)) return false;
        if (options.tier && c.tier !== options.tier) return false;
        return true;
    });
}
