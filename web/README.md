# Web console

The operator console for the agent: a React, TypeScript and Ant Design app built with Vite and
linted with oxlint. For a tour of its pages, see [The web console](../docs/web-console.md).

## Development

This folder is an npm workspace of the root project, so `npm install` at the root sets it up.
Run the backend and the dev server side by side from the repository root:

```bash
npm start          # backend and API
npm run web:dev    # Vite dev server with hot reload, forwards /api and /ws to the backend
```

## Other scripts

```bash
npm run web:build  # production build to web/dist, which the backend serves
npm run web:lint   # oxlint over web/
```

If you change how the build is split into chunks, check a real production build, not only the
dev server. The dev server does no chunking, so some problems only show up in production.
