#!/usr/bin/env tsx
/**
 * Type Generator Script
 * 
 * This script can be used to:
 * 1. Generate TypeScript types from entity definitions
 * 2. Validate entity definitions
 * 3. Generate API client method stubs
 * 4. Generate CLI command stubs
 * 
 * Usage:
 *   npm run generate:types
 */

import { ENTITIES, CUSTOM_COMMAND_GROUPS } from '../src/types/definitions';
import type { EntityName, EntityConfig, EntityOperation } from '../src/types/definitions';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '../src/types');

// ============================================================================
// VALIDATION
// ============================================================================

/** Validate entity definitions */
function validateEntities(): void {
  console.log('Validating entity definitions...');
  
  for (const [entityName, config] of Object.entries(ENTITIES)) {
    // Check required fields
    if (!config.singular) {
      throw new Error(`Entity ${entityName} is missing 'singular' field`);
    }
    if (!config.plural) {
      throw new Error(`Entity ${entityName} is missing 'plural' field`);
    }
    if (!config.cliName) {
      throw new Error(`Entity ${entityName} is missing 'cliName' field`);
    }
    if (!config.description) {
      throw new Error(`Entity ${entityName} is missing 'description' field`);
    }
    if (!config.operations || config.operations.length === 0) {
      throw new Error(`Entity ${entityName} has no operations defined`);
    }
    
    // Check field consistency
    if (config.createFields) {
      for (const field of config.createFields) {
        if (!field.name) {
          throw new Error(`Entity ${entityName} has a create field without a name`);
        }
        if (!field.type) {
          throw new Error(`Entity ${entityName} field ${field.name} is missing type`);
        }
      }
    }
    
    if (config.updateFields) {
      for (const field of config.updateFields) {
        if (!field.name) {
          throw new Error(`Entity ${entityName} has an update field without a name`);
        }
        if (!field.type) {
          throw new Error(`Entity ${entityName} field ${field.name} is missing type`);
        }
      }
    }
    
    console.log(`  ✓ ${entityName}`);
  }
  
  console.log('Entity validation passed!');
}

// ============================================================================
// TYPE GENERATION
// ============================================================================

/** Capitalize a string */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Generate TypeScript types from entity definitions */
function generateTypes(): void {
  console.log('Generating TypeScript types...');
  
  let output = `/**
 * Generated Types
 * 
 * This file is auto-generated from entity definitions.
 * Do not edit directly - run 'npm run generate:types' to regenerate.
 * 
 * Generated at: ${new Date().toISOString()}
 */

// Auto-imported types would go here

`;

  // Generate response types
  for (const [entityName, config] of Object.entries(ENTITIES)) {
    const capitalized = capitalize(entityName);
    const capitalizedPlural = capitalize(config.plural);
    
    output += `// ${capitalized} types
export interface ${capitalized}Response {
`;
    
    // Add common fields
    output += `  id: string;
`;
    output += `  createdAt: number;
`;
    
    // Add fields from createFields
    for (const field of config.createFields) {
      const fieldType = mapFieldType(field.type);
      const optional = field.required ? '' : '?';
      output += `  ${field.name}${optional}: ${fieldType};\n`;
    }
    
    // Add fields from updateFields that aren't in createFields
    for (const field of config.updateFields) {
      if (!config.createFields.some(f => f.name === field.name)) {
        const fieldType = mapFieldType(field.type);
        output += `  ${field.name}?: ${fieldType};\n`;
      }
    }
    
    output += `}\n\n`;
    
    // Generate list response type
    output += `export type List${capitalizedPlural}Response = {
  success: boolean;
  data: ${capitalized}Response[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  timestamp: number;
};\n\n`;
  }
  
  console.log('Types generated!');
}

/** Map field types to TypeScript types */
function mapFieldType(fieldType: string): string {
  const typeMap: Record<string, string> = {
    'string': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'enum': 'string',
    'date': 'string',
    'id': 'string',
    'array': 'unknown[]',
  };
  return typeMap[fieldType] || 'unknown';
}

// ============================================================================
// API CLIENT METHOD GENERATION
// ============================================================================

/** Generate API client method stubs */
function generateApiClient(): void {
  console.log('Generating API client methods...');
  
  let output = `/**
 * Generated API Client Methods
 * 
 * This file contains API client methods auto-generated from entity definitions.
 * These can be added to the main BeehiveClient class.
 * 
 * Generated at: ${new Date().toISOString()}
 */

`;

  for (const [entityName, config] of Object.entries(ENTITIES)) {
    const capitalized = capitalize(entityName);
    const capitalizedPlural = capitalize(config.plural);
    
    // List method
    if (config.operations.includes('list')) {
      output += `// List ${config.plural}
async list${capitalizedPlural}(
  limit?: number,
  offset?: number
): Promise<PaginatedResponse<${capitalized}Response>> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', limit.toString());
  if (offset !== undefined) params.set('offset', offset.toString());
  return this.request<PaginatedResponse<${capitalized}Response>>(
    'GET',
    '/${config.plural}?{\' + params.toString() + \'}'
  );
}\n\n`;
    }
    
    // Get method
    if (config.operations.includes('get')) {
      output += `// Get ${config.singular}
async get${capitalized}(id: string): Promise<${capitalized}Response> {
  return this.request<${capitalized}Response>('GET', '/${config.plural}/{\' + id + \'}');
}\n\n`;
    }
    
    // Create method
    if (config.operations.includes('create')) {
      output += `// Create ${config.singular}
async create${capitalized}(
  request: Create${capitalized}Request,
  options?: RequestOptions
): Promise<${capitalized}Response> {
  return this.request<${capitalized}Response>('POST', '/${config.plural}', request, options);
}\n\n`;
    }
    
    // Update method
    if (config.operations.includes('update')) {
      output += `// Update ${config.singular}
async update${capitalized}(
  id: string,
  request: Update${capitalized}Request,
  options?: RequestOptions
): Promise<${capitalized}Response> {
  return this.request<${capitalized}Response>('PATCH', '/${config.plural}/{\' + id + \'}', request, options);
}\n\n`;
    }
    
    // Delete method
    if (config.operations.includes('delete')) {
      output += `// Delete ${config.singular}
async delete${capitalized}(id: string): Promise<ApiResponse<void>> {
  return this.request<ApiResponse<void>>('DELETE', '/${config.plural}/{\' + id + \'}');
}\n\n`;
    }
  }
  
  console.log('API client methods generated!');
}

// ============================================================================
// CLI COMMAND GENERATION
// ============================================================================

/** Generate CLI command registration code */
function generateCliCommands(): void {
  console.log('Generating CLI commands...');
  
  let output = `/**
 * Generated CLI Commands
 * 
 * This file contains CLI command registration code auto-generated from entity definitions.
 * 
 * Generated at: ${new Date().toISOString()}
 */

import { Command } from 'commander';
import { CliState, GlobalOptions, createActionHandler } from '../index';
import { ENTITIES } from '../types/definitions';

`;

  for (const [entityName, config] of Object.entries(ENTITIES)) {
    output += `// ${config.cliName} commands
registerEntityCommands(program, '${entityName}', ENTITIES['${entityName}'], createActionHandler);

`;
  }
  
  console.log('CLI commands generated!');
}

// ============================================================================
// ENTITY SUMMARY
// ============================================================================

/** Print summary of all entities and their operations */
function printEntitySummary(): void {
  console.log('\n=== Entity Summary ===\n');
  
  for (const [entityName, config] of Object.entries(ENTITIES)) {
    console.log(`${config.cliName.padEnd(15)} | ${entityName.padEnd(15)} | ${config.operations.join(', ')}`);
  }
  
  console.log('\n=== Custom Command Groups ===\n');
  
  for (const group of CUSTOM_COMMAND_GROUPS) {
    console.log(`${group.name.padEnd(15)} | ${group.description}`);
    for (const cmd of group.commands) {
      console.log(`  - ${cmd.name.padEnd(20)} | ${cmd.description}`);
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main(): void {
  console.log('Beehive Type Generator\n');
  console.log('='.repeat(50));
  console.log('');
  
  try {
    // Validate definitions
    validateEntities();
    console.log('');
    
    // Print summary
    printEntitySummary();
    console.log('');
    
    // Generate types
    generateTypes();
    console.log('');
    
    // Generate API client
    generateApiClient();
    console.log('');
    
    // Generate CLI commands
    generateCliCommands();
    console.log('');
    
    console.log('='.repeat(50));
    console.log('Generation complete!');
    
  } catch (error) {
    console.error('Generation failed:', error);
    process.exit(1);
  }
}

main();
