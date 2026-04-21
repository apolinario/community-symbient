#!/bin/bash
# Start llama.cpp servers for Feyblet
# 27B: auto-split across both GPUs, 64K context, parallel 2
# LFM: 4090 only, Q4 with mmproj, 8K context, parallel 2
# TTS: 5090 via systemd (separate service)

LLAMA_SERVER="/home/plantoidz/llama-cpp-build/build/bin/llama-server"
MAIN_MODEL="/home/plantoidz/.cache/lm-studio/models/lmstudio-community/Qwen3.5-27B-GGUF/Qwen3.5-27B-Q4_K_M.gguf"
MAIN_MMPROJ="/home/plantoidz/.cache/lm-studio/models/lmstudio-community/Qwen3.5-27B-GGUF/mmproj-Qwen3.5-27B-BF16.gguf"
TINY_MODEL="/home/plantoidz/.cache/lm-studio/models/LiquidAI/LFM2.5-VL-1.6B-GGUF/LFM2.5-VL-1.6B-Q4_0.gguf"
TINY_MMPROJ="/home/plantoidz/.cache/lm-studio/models/LiquidAI/LFM2.5-VL-1.6B-GGUF/mmproj-LFM2.5-VL-1.6b-Q8_0.gguf"
MAIN_PORT=1234
TINY_PORT=1235
# 4090 UUID for pinning LFM
GPU_4090="GPU-3dc3ec12-9730-f94b-31fe-d6d44dc24f71"

wait_for() {
    local name=$1 port=$2
    for i in $(seq 1 120); do
        if curl -s --max-time 2 "http://localhost:$port/v1/models" > /dev/null 2>&1; then
            echo "[llm] $name ready after ${i}s"
            return 0
        fi
        sleep 1
    done
    echo "[llm] ERROR: $name failed to start after 120s"
    return 1
}

start_main() {
    if curl -s --max-time 2 "http://localhost:$MAIN_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] main already running"; return; fi
    echo "[llm] Starting main (64K context, parallel 2, auto-split)..."
    $LLAMA_SERVER \
        -m "$MAIN_MODEL" \
        --mmproj "$MAIN_MMPROJ" \
        --host 0.0.0.0 --port "$MAIN_PORT" \
        -ngl 99 --tensor-split 3,7 \
        -c 131072 --parallel 2 --jinja \
        > /tmp/llama-main.log 2>&1 &
    wait_for "main" "$MAIN_PORT"
}

start_tiny() {
    if curl -s --max-time 2 "http://localhost:$TINY_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] tiny already running"; return; fi
    echo "[llm] Starting tiny (8K context, parallel 2, 4090)..."
    CUDA_VISIBLE_DEVICES=$GPU_4090 \
    $LLAMA_SERVER \
        -m "$TINY_MODEL" \
        --mmproj "$TINY_MMPROJ" \
        --host 0.0.0.0 --port "$TINY_PORT" \
        -ngl 99 \
        -c 8192 --parallel 2 --jinja \
        > /tmp/llama-tiny.log 2>&1 &
    wait_for "tiny" "$TINY_PORT"
}

start_main
start_tiny
echo "[llm] All models ready"

while true; do
    sleep 30
    if ! curl -s --max-time 10 "http://localhost:$MAIN_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] WARNING: main not responding, restarting..."
        pkill -f "llama-server.*$MAIN_PORT" 2>/dev/null; sleep 3; start_main
    fi
    if ! curl -s --max-time 5 "http://localhost:$TINY_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] WARNING: tiny not responding, restarting..."
        pkill -f "llama-server.*$TINY_PORT" 2>/dev/null; sleep 3; start_tiny
    fi
done
