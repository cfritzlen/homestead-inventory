"""Homestead Hub API — PostgREST-compatible backend replacing Supabase."""

import os
import json
import re
from contextlib import asynccontextmanager

import httpx
import psycopg2
import psycopg2.extras
from fastapi import FastAPI, Request, Response, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse

DATABASE_URL = os.environ.get("DATABASE_URL", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
RECEIPTS_DIR = "/app/receipts"

# Parse DATABASE_URL for psycopg2 (strip the +asyncpg part)
DB_CONN_STR = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


def get_db():
    conn = psycopg2.connect(DB_CONN_STR)
    conn.autocommit = True
    return conn


# Allowed tables (prevent SQL injection)
ALLOWED_TABLES = {
    "solar_readings", "solar_daily_summary", "solar_realtime", "solar_electric_bills",
    "meds", "med_logs", "bp_readings", "med_notes", "sleep_entries",
    "recipes", "master_items", "recipe_ingredients", "recipe_steps", "meal_plan",
    "shopping_list", "inventory",
    "home_vendors", "home_expenses", "home_expense_receipts",
    "finance_accounts", "finance_transactions", "finance_bills", "finance_bill_payments",
    "finance_weekly_entries", "finance_loan_schedules", "finance_other_payments",
    "finance_extra_payments", "finance_categories",
    "hatching_batches", "homestead_chores", "plant_entries", "plant_photos", "harvest_log",
    "brain_topics", "brain_people", "brain_tags", "brain_documents", "brain_memories",
    "prediction_trades",
}


def parse_postgrest_filters(params: dict) -> tuple[str, list]:
    """Parse PostgREST-style query params into SQL WHERE clause."""
    where_parts = []
    values = []
    order_clause = ""
    limit_clause = ""
    offset_clause = ""

    operators = {
        "eq": "=", "neq": "!=", "gt": ">", "gte": ">=",
        "lt": "<", "lte": "<=", "like": "LIKE", "ilike": "ILIKE",
        "is": "IS",
    }

    for key, val in params.items():
        if key == "select" or key == "on_conflict":
            continue
        elif key == "order":
            # Support multiple order columns: display_order.asc,name.asc
            order_parts = []
            for segment in val.split(","):
                seg_parts = segment.strip().split(".")
                col = seg_parts[0]
                direction = seg_parts[1].upper() if len(seg_parts) > 1 else "ASC"
                nulls = ""
                if len(seg_parts) > 2 and seg_parts[2].lower() == "nullsfirst":
                    nulls = " NULLS FIRST"
                if direction not in ("ASC", "DESC"):
                    direction = "ASC"
                order_parts.append(f'"{col}" {direction}{nulls}')
            order_clause = " ORDER BY " + ", ".join(order_parts)
        elif key == "limit":
            limit_clause = f" LIMIT {int(val)}"
        elif key == "offset":
            offset_clause = f" OFFSET {int(val)}"
        else:
            # field=op.value format
            match = re.match(r"^(eq|neq|gt|gte|lt|lte|like|ilike|is)\.(.*)$", val)
            if match:
                op_key, op_val = match.groups()
                sql_op = operators[op_key]
                if op_key == "is":
                    if op_val.lower() == "null":
                        where_parts.append(f'"{key}" IS NULL')
                    elif op_val.lower() == "true":
                        where_parts.append(f'"{key}" IS TRUE')
                    elif op_val.lower() == "false":
                        where_parts.append(f'"{key}" IS FALSE')
                else:
                    where_parts.append(f'"{key}" {sql_op} %s')
                    values.append(op_val)

    where_sql = ""
    if where_parts:
        where_sql = " WHERE " + " AND ".join(where_parts)

    return where_sql + order_clause + limit_clause + offset_clause, values


app = FastAPI(title="Homestead Hub API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/{table}")
async def get_rows(table: str, request: Request):
    if table not in ALLOWED_TABLES:
        raise HTTPException(404, f"Table '{table}' not found")

    params = dict(request.query_params)
    select = params.get("select", "*")
    suffix, values = parse_postgrest_filters(params)

    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute(f'SELECT {select} FROM {table}{suffix}', values)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    # Convert to serializable format
    result = [dict(r) for r in rows]
    return JSONResponse(content=json.loads(json.dumps(result, default=str)))


@app.post("/api/{table}")
async def insert_row(table: str, request: Request):
    if table not in ALLOWED_TABLES:
        raise HTTPException(404, f"Table '{table}' not found")

    body = await request.json()
    rows = body if isinstance(body, list) else [body]

    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    results = []

    # Handle upsert via Prefer header
    prefer = request.headers.get("Prefer", "")
    on_conflict = request.query_params.get("on_conflict", "")

    for row in rows:
        columns = list(row.keys())
        col_list = ", ".join(f'"{c}"' for c in columns)
        placeholders = ", ".join(["%s"] * len(columns))
        values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]

        sql = f'INSERT INTO {table} ({col_list}) VALUES ({placeholders})'

        if on_conflict:
            conflict_cols = ", ".join(f'"{c}"' for c in on_conflict.split(","))
            if "merge-duplicates" in prefer:
                update_cols = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in columns if c not in on_conflict.split(","))
                if update_cols:
                    sql += f' ON CONFLICT ({conflict_cols}) DO UPDATE SET {update_cols}'
                else:
                    sql += f' ON CONFLICT ({conflict_cols}) DO NOTHING'
            elif "ignore-duplicates" in prefer:
                sql += f' ON CONFLICT ({conflict_cols}) DO NOTHING'

        sql += " RETURNING *"
        cur.execute(sql, values)
        result = cur.fetchone()
        if result:
            results.append(dict(result))

    cur.close()
    conn.close()
    return JSONResponse(
        content=json.loads(json.dumps(results, default=str)),
        status_code=201
    )


@app.patch("/api/{table}")
async def update_rows(table: str, request: Request):
    if table not in ALLOWED_TABLES:
        raise HTTPException(404, f"Table '{table}' not found")

    body = await request.json()
    params = dict(request.query_params)
    suffix, filter_values = parse_postgrest_filters(params)

    set_parts = []
    set_values = []
    for key, val in body.items():
        set_parts.append(f'"{key}" = %s')
        set_values.append(json.dumps(val) if isinstance(val, (list, dict)) else val)

    conn = get_db()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    sql = f'UPDATE {table} SET {", ".join(set_parts)}{suffix} RETURNING *'
    cur.execute(sql, set_values + filter_values)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    return JSONResponse(content=json.loads(json.dumps([dict(r) for r in rows], default=str)))


@app.delete("/api/{table}")
async def delete_rows(table: str, request: Request):
    if table not in ALLOWED_TABLES:
        raise HTTPException(404, f"Table '{table}' not found")

    params = dict(request.query_params)
    suffix, values = parse_postgrest_filters(params)

    conn = get_db()
    cur = conn.cursor()
    cur.execute(f'DELETE FROM {table}{suffix}', values)
    cur.close()
    conn.close()

    return Response(status_code=204)


# File upload/download (replaces Supabase Storage)
@app.post("/api/upload/{filename}")
async def upload_file(filename: str, file: UploadFile = File(...)):
    os.makedirs(RECEIPTS_DIR, exist_ok=True)
    filepath = os.path.join(RECEIPTS_DIR, filename)
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)
    return {"key": filename, "size": len(content)}


@app.get("/api/files/{filename}")
async def get_file(filename: str):
    filepath = os.path.join(RECEIPTS_DIR, filename)
    if not os.path.exists(filepath):
        raise HTTPException(404, "File not found")
    return FileResponse(filepath)


# AI proxy (replaces Anthropic API calls)
@app.post("/api/ai/chat")
async def ai_chat(request: Request):
    body = await request.json()
    prompt = body.get("prompt", "")
    system = body.get("system", "")
    max_tokens = body.get("max_tokens", 1024)

    full_prompt = f"{system}\n\n{prompt}" if system else prompt

    async with httpx.AsyncClient(timeout=120) as client:
        try:
            resp = await client.post(f"{OLLAMA_URL}/api/generate", json={
                "model": "llama3.2:3b",
                "prompt": full_prompt,
                "stream": False,
                "options": {"num_predict": max_tokens},
            })
            resp.raise_for_status()
            data = resp.json()
            return {"content": [{"text": data.get("response", "")}]}
        except httpx.ConnectError:
            raise HTTPException(503, "AI offline — Raspberry Pi not reachable")
        except Exception as e:
            raise HTTPException(503, f"AI service unavailable: {e}")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
