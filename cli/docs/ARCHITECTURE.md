# CLI Architecture - Type-Driven Design

## Overview

The Beehive CLI uses a **type-driven architecture** to minimize repetition across phases. This design allows adding new entities and commands for Phase 2 and Phase 3 with minimal code changes.

## Core Principles

1. **Single Source of Truth**: Entity definitions in `src/types/definitions.ts` drive all other code
2. **Code Generation**: Types, API methods, and CLI commands are generated from definitions
3. **Separation of Concerns**: CRUD operations are automated, custom commands are manual
4. **Phase Extensibility**: New phases only require adding to definitions

---

## Architecture Components

### 1. Entity Definitions (`src/types/definitions.ts`)

The central file containing all entity configurations:

```typescript
// Example entity definition
organization: {
  singular: 'organization',
  plural: 'organizations',
  cliName: 'org',
  description: 'Organization management',
  operations: ['list', 'get', 'create'],
  createFields: [
    { name: 'name', type: 'string', required: true, description: 'Organization name' },
    { name: 'type', type: 'enum', required: true, description: 'Organization type', enumValues: ['github', 'gitlab', 'artifacts'] },
  ],
  updateFields: [
    { name: 'name', type: 'string', required: false, description: 'Organization name' },
  ],
  listDisplayFields: ['id', 'name', 'type', 'createdAt'],
}
```

**Fields:**
- `singular` / `plural`: Entity names for API endpoints and messages
- `cliName`: Short command name (e.g., `org` for organization)
- `description`: CLI help text
- `operations`: Enabled CRUD operations
- `createFields` / `updateFields`: Fields for create/update operations
- `listDisplayFields`: Fields shown in list output
- `customCommands`: Entity-specific non-CRUD commands

### 2. Type Generator (`src/types/generated.ts`)

Auto-generated types from entity definitions:

```typescript
// Entity response types
export interface OrganizationResponse {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  createdAt: number;
}

// List response types
export type ListOrganizationsResponse = {
  success: boolean;
  data: OrganizationResponse[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  timestamp: number;
};
```

### 3. Command Factory (`src/utils/command-factory.ts`)

Automatically generates CRUD CLI commands:

```typescript
// Register all entity commands
export function registerAllEntityCommands(
  program: Command,
  createHandler: ActionHandler
): void {
  for (const [entityName, config] of Object.entries(ENTITIES)) {
    registerEntityCommands(program, entityName, config, createHandler);
  }
}
```

**Features:**
- Auto-creates list, get, create, update, delete commands
- Adds appropriate arguments and options
- Generates help text automatically
- Handles errors consistently

### 4. API Client Generation

The generator script can produce API client method stubs:

```typescript
// Generated from entity definitions
async listOrganizations(limit?: number, offset?: number): Promise<PaginatedResponse<OrganizationResponse>> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit.toString());
  if (offset !== undefined) params.set('offset', offset.toString());
  return this.request<PaginatedResponse<OrganizationResponse>>(
    'GET',
    `/organizations?${params.toString()}`
  );
}
```

---

## Command Structure

### CRUD Commands (Generated)

All entities automatically get CRUD commands based on their operations:

```bash
# List
beehive org list
beehive org list --limit 50
beehive org list --all

# Get
beehive org get <id>

# Create
beehive org create --name "My Org" --type github

# Update
beehive org update <id> --name "New Name"

# Delete
beehive org delete <id> --force
```

### Custom Commands (Manual)

Commands that don't fit CRUD patterns are defined in `CUSTOM_COMMAND_GROUPS`:

```typescript
{
  name: 'debug',
  description: 'Debugging utilities',
  commands: [
    {
      name: 'check-api',
      description: 'Check API connectivity',
      action: 'actionCheckApi',
    },
    // ...
  ],
}
```

These are registered manually in `src/index.ts`.

---

## Adding New Entities for Phase 2 and Phase 3

### Step 1: Add Entity Definition

Edit `src/types/definitions.ts` and add your new entity:

```typescript
export const ENTITIES: Record<string, EntityConfig> = {
  // ... existing entities
  
  // Phase 2: Workflow
  workflow: {
    singular: 'workflow',
    plural: 'workflows',
    cliName: 'workflow',
    description: 'Workflow management',
    operations: ['list', 'get', 'trigger', 'cancel'],
    createFields: [
      { name: 'specId', type: 'id', required: true, description: 'Spec ID' },
      { name: 'workflowType', type: 'enum', required: true, description: 'Workflow type', 
        enumValues: ['gate', 'build', 'test', 'deploy'] },
    ],
    updateFields: [
      { name: 'status', type: 'enum', required: false, description: 'Workflow status',
        enumValues: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
    ],
    listDisplayFields: ['id', 'specId', 'workflowType', 'status', 'createdAt'],
  },
  
  // Phase 3: Deployment
  deployment: {
    singular: 'deployment',
    plural: 'deployments',
    cliName: 'deploy',
    description: 'Deployment management',
    operations: ['list', 'get', 'create', 'rollback'],
    createFields: [
      { name: 'candidateId', type: 'id', required: true, description: 'Candidate ID' },
      { name: 'environment', type: 'string', required: true, description: 'Environment' },
    ],
    updateFields: [],
    listDisplayFields: ['id', 'candidateId', 'environment', 'status', 'createdAt'],
    operationConfig: {
      rollback: {
        requiresId: true,
        options: [
          { name: 'to-version', type: 'string', description: 'Rollback to version' },
        ],
      },
    },
  },
  
  // ...
};
```

### Step 2: Regenerate Types (Optional)

Run the generator to update generated files:

```bash
npm run generate:types
```

This validates definitions and can generate type stubs.

### Step 3: Verify Compilation

```bash
npm run typecheck
```

### Step 4: Use the CLI

The new commands are automatically available:

```bash
# Phase 2
beehive workflow list
beehive workflow trigger <id> --input '{}'
beehive workflow cancel <id>

# Phase 3
beehive deploy list
beehive deploy create --candidateId <id> --environment production
beehive deploy rollback <id> --to-version v1.0.0
```

---

## Custom Commands

For commands that don't fit CRUD patterns (like debug utilities), add them to `CUSTOM_COMMAND_GROUPS`:

```typescript
{
  name: 'debug',
  description: 'Debugging utilities for e2e testing',
  commands: [
    {
      name: 'check-api',
      category: 'debug',
      description: 'Check API connectivity',
      action: 'actionCheckApi',
    },
    {
      name: 'list-specs',
      category: 'debug',
      description: 'List all specs with their stages',
      action: 'actionListSpecsStages',
      options: [
        { name: 'all', short: 'a', type: 'boolean', description: 'Show all details' },
        { name: 'limit', short: 'l', type: 'number', description: 'Limit number of specs' },
      ],
    },
    // ...
  ],
}
```

Then implement the action function in the appropriate file (e.g., `src/commands/debug.ts`).

---

## Type System

### Entity Types

```typescript
// Get entity config
type OrgConfig = EntityConfigForName<'organization'>;

// Get field names
type OrgCreateFields = EntityFieldNames<'organization', 'create'>;
// => 'name' | 'type' | 'externalId'

// Get request types
type CreateOrgRequest = CreateRequest<'organization'>;
// => { name: string; type: 'github' | 'gitlab' | 'artifacts'; externalId?: string }
```

### Utility Types

```typescript
// Check if entity has operation
type CanList = HasOperation<'organization', 'list'>; // true
type CanDelete = HasOperation<'organization', 'delete'>; // false (not in operations)

// Filter entities by operation
type ListableEntities = EntitiesWithOperation<'list'>;
// => 'organization' | 'actor' | 'repository' | ...
```

---

## Generator Script

The `scripts/generate-types.ts` script provides:

1. **Validation**: Checks entity definitions for errors
2. **Type Generation**: Creates TypeScript type definitions
3. **API Generation**: Generates API client method stubs
4. **CLI Generation**: Generates CLI command registration code
5. **Summary**: Prints all entities and their operations

Run it with:

```bash
npm run generate:types
```

Output includes:
- Entity validation results
- Entity summary table
- Custom command groups
- Phase breakdown

---

## Migration Guide

### For Phase 2

1. Add entities to `ENTITIES` in `src/types/definitions.ts`
2. Add custom commands to `CUSTOM_COMMAND_GROUPS` if needed
3. Implement action functions for custom commands
4. Run `npm run typecheck` to verify
5. Test with `npm run dev`

### For Phase 3

Same as Phase 2 - just add entities and custom commands.

---

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| Adding new entity | 100+ lines in 3+ files | ~20 lines in definitions |
| Adding new operation | Manual updates everywhere | Just add to operations array |
| Type safety | Manual type definitions | Auto-generated from definitions |
| Consistency | Manual enforcement | Automatic via generator |
| Documentation | Manual updates | Auto-generated |
| Error handling | Inconsistent | Consistent via factory |

---

## File Structure

```
cli/
├── src/
│   ├── types/
│   │   ├── definitions.ts    # Entity definitions (edit this for new phases)
│   │   ├── generated.ts      # Generated types
│   │   └── config.ts         # CLI configuration types
│   ├── utils/
│   │   ├── api-client.ts     # API client
│   │   ├── command-factory.ts # Command factory
│   │   └── output.ts         # Output formatting
│   ├── commands/
│   │   ├── auth.ts          # Auth commands (manual)
│   │   ├── debug.ts         # Debug commands (manual)
│   │   ├── health.ts        # Health commands (manual)
│   │   └── ...
│   └── index.ts             # Main entry point
├── scripts/
│   └── generate-types.ts    # Type generator script
└── package.json
```

---

## Best Practices

1. **Always validate definitions**: Run `npm run generate:types` after changes
2. **Use descriptive field names**: Field names become CLI option names
3. **Specify required fields**: Mark required fields in createFields
4. **Add descriptions**: All fields should have descriptions for help text
5. **Test typecheck**: Always run `npm run typecheck` after changes
6. **Keep custom commands focused**: Use CRUD for standard operations

---

## Examples

### Adding a New Entity

```typescript
// In src/types/definitions.ts
mulcher: {
  singular: 'mulcher',
  plural: 'mulchers',
  cliName: 'mulch',
  description: 'Mulcher service management',
  operations: ['list', 'get', 'create', 'update', 'delete'],
  createFields: [
    { name: 'name', type: 'string', required: true, description: 'Mulcher name' },
    { name: 'type', type: 'enum', required: true, description: 'Mulcher type', 
      enumValues: ['wood', 'leaf', 'compost'] },
    { name: 'capacity', type: 'number', required: false, description: 'Capacity in tons' },
  ],
  updateFields: [
    { name: 'name', type: 'string', required: false, description: 'Mulcher name' },
    { name: 'capacity', type: 'number', required: false, description: 'Capacity in tons' },
    { name: 'status', type: 'enum', required: false, description: 'Status',
      enumValues: ['active', 'maintenance', 'offline'] },
  ],
  listDisplayFields: ['id', 'name', 'type', 'status', 'capacity'],
},
```

### Using Generated Commands

```bash
# All commands are automatically available
beehive mulch list --limit 10
beehive mulch get abc123
beehive mulch create --name "Wood Chipper" --type wood --capacity 5
beehive mulch update abc123 --status maintenance
beehive mulch delete abc123 --force
```

---

## Troubleshooting

### Type Errors

If you get type errors after adding an entity:

1. Check that all required fields are defined
2. Ensure field types are valid ('string', 'number', 'boolean', 'enum', 'date', 'id', 'array')
3. Verify that custom command options don't use EntityField properties (use CommandOption instead)
4. Run `npm run generate:types` to validate definitions

### Missing Commands

If a command is missing:

1. Check that the operation is in the `operations` array
2. Verify the entity is in `ENTITIES`
3. Ensure the command factory is being called in `src/index.ts`

### CLI Not Updating

After changes:

1. Run `npm run build` to rebuild
2. Use the wrapper script: `/tmp/beehive-cli`
3. Or run directly: `npx tsx src/index.ts`
