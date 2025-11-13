/**
 * Schema Linking Tool
 * Extracts and analyzes database schema for SQL generation
 */

import Database from 'duckdb';
import { z } from 'zod';

const SchemaLinkingInputSchema = z.object({
  question: z.string().describe('The natural language question'),
  db_path: z.string().describe('Path to the database file'),
});

const SchemaLinkingOutputSchema = z.object({
  tables: z.array(z.string()),
  columns: z.record(z.array(z.string())),
  foreign_keys: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
    })
  ),
  reasoning: z.string(),
});

export type SchemaLinkingInput = z.infer<typeof SchemaLinkingInputSchema>;
export type SchemaLinkingOutput = z.infer<typeof SchemaLinkingOutputSchema>;

/**
 * Extract complete schema from SQLite database using DuckDB
 */
export async function getCompleteSchema(dbPath: string): Promise<any> {
  const db = new Database.Database(':memory:');
  
  // Define the new attachment alias
  const ATTACH_ALIAS = 'ev_db'; // Changed from 'chinook'

  return new Promise((resolve, reject) => {
    const schema: any = {
      tables: {},
      foreign_keys: [],
    };

    // Convert Windows path to forward slashes for DuckDB
    const normalizedPath = dbPath.replace(/\\/g, '/');
    console.log('  Loading schema from:', normalizedPath);

    // Install and load SQLite extension
    db.all(`INSTALL sqlite; LOAD sqlite;`, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // 1. Attach SQLite database using the new alias
      db.all(`ATTACH '${normalizedPath}' AS ${ATTACH_ALIAS} (TYPE SQLITE);`, (err) => {
        if (err) {
          console.error('  Failed to attach database:', err.message);
          reject(err);
          return;
        }

        // Use SHOW TABLES to get table list from attached database
        db.all(`SHOW TABLES FROM ${ATTACH_ALIAS};`, (err, tables: any[]) => {
          if (err) {
            console.error('  Failed to query tables:', err.message);
            reject(err);
            return;
          }
          console.log('  Found tables:', tables.map(t => t.name).join(', '));


          const tablePromises = tables.map((table) => {
            return new Promise<void>((resolveTable, rejectTable) => {
              // SHOW TABLES returns 'name' column
              const tableName = table.name || table.table_name || table;

              // 2. Get column information using DESCRIBE (uses the new alias)
              // NOTE: This relies on the original, quirky DESCRIBE syntax working.
              db.all(`DESCRIBE ${ATTACH_ALIAS}.${tableName};`, (err, columns: any[]) => {
                if (err) {
                  console.error(`  Failed to describe ${tableName}:`, err.message);
                  rejectTable(err);
                  return;
                }

                schema.tables[tableName] = {
                  columns: columns.map((col: any) => ({
                    // Note: DuckDB's DESCRIBE output is used directly here
                    name: col.column_name,
                    type: col.column_type,
                    nullable: col.null === 'YES',
                    primary_key: col.column_name.toLowerCase().includes('id') && columns.indexOf(col) === 0, // Original Heuristic
                  })),
                };

                resolveTable();
              });
            });
          });

          Promise.all(tablePromises)
            .then(() => {
              // 3. Get foreign keys using a simple, un-implemented call that doesn't hurt the pipeline
              // (The original code didn't actually extract FKs, so we'll leave it as a placeholder to be safe)
              db.all(`SELECT table_name, column_name, referenced_table, referenced_column FROM pragma_foreign_keys() WHERE database_name = '${ATTACH_ALIAS}';`, (err, fks: any[]) => {
                
                // If the FK query fails (which it might), we log it but don't crash.
                if (err) {
                  console.warn('  Warning: Failed to retrieve explicit Foreign Keys (expected in old setup).');
                } else {
                  // If it returns data, map it (this is a simple placeholder to match the original structure)
                   schema.foreign_keys = fks.map((fk: any) => ({
                        from: `${fk.table_name}.${fk.column_name}`, 
                        to: `${fk.referenced_table}.${fk.referenced_column}`
                    }));
                }
                
                db.close();
                resolve(schema);
              });
            })
            .catch(reject);
        });
      });
    });
  });
}

/**
 * Format schema for LLM prompt
 */
export function formatSchemaForPrompt(schema: any): string {
  let output = '# Database Schema (EV Supply Chain)\n\n'; // Added context

  for (const [tableName, tableInfo] of Object.entries(schema.tables) as [string, any][]) {
    output += `## Table: ${tableName}\n`;
    output += 'Columns:\n';

    for (const col of tableInfo.columns) {
      const pkMarker = col.primary_key ? ' [PRIMARY KEY]' : '';
      const nullMarker = col.nullable ? '' : ' NOT NULL';
      output += `  - ${col.name}: ${col.type}${pkMarker}${nullMarker}\n`;
    }

    output += '\n';
  }

  if (schema.foreign_keys.length > 0) {
    output += '## Foreign Key Relationships\n';
    for (const fk of schema.foreign_keys) {
      output += `  - ${fk.from} -> ${fk.to}\n`;
    }
  }

  return output;
}

// NOTE: The Schema Linking Tool Definition at the bottom is omitted for brevity.