#!/usr/bin/env python3
"""
Database Migration Runner

Applies SQL migrations from the migrations/ directory to the database.
Tracks which migrations have been applied using a migrations_applied table.
"""

import os
import sqlite3
from pathlib import Path


def get_db_path():
    """Get database path from environment or use default."""
    return os.getenv("DB_PATH", "./data/ev_supply_chain.db")


def ensure_migrations_table(conn):
    """Create migrations_applied table if it doesn't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS migrations_applied (
            migration_file TEXT PRIMARY KEY,
            applied_utc TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.commit()


def get_applied_migrations(conn):
    """Get set of already-applied migration files."""
    cur = conn.cursor()
    cur.execute("SELECT migration_file FROM migrations_applied")
    return {row[0] for row in cur.fetchall()}


def get_migration_files(migrations_dir):
    """Get sorted list of migration SQL files."""
    migrations_dir = Path(migrations_dir)
    if not migrations_dir.exists():
        return []
    
    sql_files = sorted(migrations_dir.glob("*.sql"))
    return [(f.name, f) for f in sql_files]


def apply_migration(conn, migration_name, migration_path):
    """Apply a single migration file."""
    print(f"Applying migration: {migration_name}")
    
    with open(migration_path, 'r') as f:
        sql = f.read()
    
    # Execute migration
    conn.executescript(sql)
    
    # Record that migration was applied
    conn.execute(
        "INSERT INTO migrations_applied (migration_file) VALUES (?)",
        (migration_name,)
    )
    conn.commit()
    
    print(f"✅ Applied: {migration_name}")


def run_migrations(db_path=None, migrations_dir=None):
    """
    Run all pending migrations.
    
    Args:
        db_path: Path to database (defaults to env var or ./data/ev_supply_chain.db)
        migrations_dir: Path to migrations directory (defaults to ./migrations)
    
    Returns:
        Number of migrations applied
    """
    db_path = db_path or get_db_path()
    
    if migrations_dir is None:
        # Default to migrations/ in same directory as this script
        script_dir = Path(__file__).parent
        migrations_dir = script_dir / "migrations"
    
    print(f"Database: {db_path}")
    print(f"Migrations directory: {migrations_dir}")
    print()
    
    # Connect to database
    conn = sqlite3.connect(db_path)
    
    try:
        # Ensure migrations tracking table exists
        ensure_migrations_table(conn)
        
        # Get already-applied migrations
        applied = get_applied_migrations(conn)
        print(f"Already applied: {len(applied)} migrations")
        
        # Get all migration files
        migrations = get_migration_files(migrations_dir)
        print(f"Found: {len(migrations)} migration files")
        print()
        
        # Apply pending migrations
        applied_count = 0
        for migration_name, migration_path in migrations:
            if migration_name not in applied:
                apply_migration(conn, migration_name, migration_path)
                applied_count += 1
            else:
                print(f"⏭️  Skipping (already applied): {migration_name}")
        
        print()
        print(f"✅ Migrations complete: {applied_count} applied")
        
        return applied_count
        
    finally:
        conn.close()


if __name__ == "__main__":
    import sys
    
    # Allow passing custom DB path as argument
    db_path = sys.argv[1] if len(sys.argv) > 1 else None
    
    try:
        run_migrations(db_path=db_path)
    except Exception as e:
        print(f"❌ Error running migrations: {e}")
        sys.exit(1)


