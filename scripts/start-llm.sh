#!/bin/bash
# Start llama.cpp servers for Feyblet
# Two instances split across both GPUs (CUDA 0=4090, 1=5090)
# Or via systemd: lmstudio.service

LLAMA_SERVER="/home/plantoidz/llama-cpp-build/build/bin/llama-server"
MAIN_MODEL="/home/plantoidz/.cache/lm-studio/models/lmstudio-community/Qwen3.5-27B-GGUF/Qwen3.5-27B-Q4_K_M.gguf"
TINY_MODEL="/home/plantoidz/.cache/lm-studio/models/lmstudio-community/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf"
MAIN_PORT=1234
TINY_PORT=1235

wait_for() {
    local name=$1 port=$2
    for i in $(seq 1 60); do
        if curl -s --max-time 2 "http://localhost:$port/v1/models" > /dev/null 2>&1; then
            echo "[llm] $name ready after ${i}s"
            return 0
        fi
        sleep 1
    done
    echo "[llm] ERROR: $name failed to start after 60s"
    return 1
}

start_main() {
    if curl -s --max-time 2 "http://localhost:$MAIN_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] main already running"; return; fi
    echo "[llm] Starting main (128K context, split GPUs, 5090 primary)..."
    $LLAMA_SERVER \
        -m "$MAIN_MODEL" \
        --host 0.0.0.0 --port "$MAIN_PORT" \
        -ngl 99 --split-mode layer --main-gpu 1 --tensor-split 0,1 \
        -c 131072 --parallel 4 --jinja \
        > /tmp/llama-main.log 2>&1 &
    wait_for "main" "$MAIN_PORT"
}

start_tiny() {
    if curl -s --max-time 2 "http://localhost:$TINY_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] tiny already running"; return; fi
    echo "[llm] Starting tiny (8K context, split GPUs)..."
    $LLAMA_SERVER \
        -m "$TINY_MODEL" \
        --host 0.0.0.0 --port "$TINY_PORT" \
        -ngl 99 --split-mode layer --tensor-split 1,1 \
        -c 8192 --parallel 4 --jinja \
        > /tmp/llama-tiny.log 2>&1 &
    wait_for "tiny" "$TINY_PORT"
}

start_main
start_tiny
echo "[llm] All models ready"

while true; do
    sleep 30
    if ! curl -s --max-time 5 "http://localhost:$MAIN_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] WARNING: main not responding, restarting..."
        pkill -f "llama-server.*$MAIN_PORT" 2>/dev/null; sleep 3; start_main
    fi
    if ! curl -s --max-time 5 "http://localhost:$TINY_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] WARNING: tiny not responding, restarting..."
        pkill -f "llama-server.*$TINY_PORT" 2>/dev/null; sleep 3; start_tiny
    fi
done
