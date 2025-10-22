# Agent Guidelines

## Commands
- `bun test` - Run all tests
- `bun test <filename>` - Run single test file (e.g., `bun test converters.test.ts`)
- `bun run build` - Build the project
- `bun run lint` - Check code with Biome
- `bun run lint:fix` - Auto-fix linting issues
- `bun run format` - Format code with Biome
- `bun run dev` - Build and start in development mode

## Code Style
- Use Biome for linting and formatting
- TypeScript with strict mode enabled
- ES2020 target, NodeNext module resolution
- Import style: ES6 imports with `.js` extensions for local modules
- Error handling: Use try/catch blocks, log errors to console.error
- Naming: camelCase for variables/functions, PascalCase for classes
- No comments unless explicitly requested
- Console methods redirected to console.error in index.ts
- Use async/await for asynchronous operations
- Interface definitions for complex objects
- Type assertions only when necessary (use `as any` sparingly)