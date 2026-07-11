#!/bin/bash
# Start llama.cpp servers for Feyblet
# Main: Qwen3.6-35B-A3B (MoE, 3B active params), no vision (mmproj kept on
# disk for later — set SYMBIENT_VISION_ENABLED in feyblet.service to mirror).
# Tensor-split 7,3 — 5090 majority, 4090 carries the rest.
# Tiny: LFM2.5-VL on 5090 only (vision-capable, separate port for tools).

# Clean slate: no CUDA env bleed from parent.
unset CUDA_VISIBLE_DEVICES
# Pin CUDA device ordering to PCI bus order so indices are stable across reboots.
# Bus 01:00 = 5090 = Device 0; bus 02:00 = 4090 = Device 1.
export CUDA_DEVICE_ORDER=PCI_BUS_ID

LLAMA_SERVER="/home/plantoidz/llama-cpp-build/build/bin/llama-server"
MAIN_MODEL="/home/plantoidz/.cache/lm-studio/models/unsloth/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
# Vision adapter for the main model — kept on disk so flipping vision back
# on later is a one-line uncomment in start_main(). Leave commented while
# SYMBIENT_VISION_ENABLED=false to save VRAM.
MAIN_MMPROJ="/home/plantoidz/.cache/lm-studio/models/unsloth/Qwen3.6-35B-A3B-GGUF/mmproj-F16.gguf"
TINY_MODEL="/home/plantoidz/.cache/lm-studio/models/LiquidAI/LFM2.5-VL-1.6B-GGUF/LFM2.5-VL-1.6B-Q4_0.gguf"
TINY_MMPROJ="/home/plantoidz/.cache/lm-studio/models/LiquidAI/LFM2.5-VL-1.6B-GGUF/mmproj-LFM2.5-VL-1.6b-Q8_0.gguf"
MAIN_PORT=1234
TINY_PORT=1235
# 4090 UUID for pinning LFM
GPU_4090="GPU-3dc3ec12-9730-f94b-31fe-d6d44dc24f71"
# 5090 UUID
GPU_5090="GPU-32c0855d-96fb-3803-4ac4-2e4dec99e7ff"

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
    echo "[llm] Starting main (Qwen3.6-35B-A3B Q4_K_M, 128K context, parallel 2, tensor-split 9,1 — vision OFF)..."
    $LLAMA_SERVER \
        -m "$MAIN_MODEL" \
        --host 0.0.0.0 --port "$MAIN_PORT" \
        -ngl 99 --tensor-split 9,1 \
        -c 131072 --parallel 2 --jinja \
        > /tmp/llama-main.log 2>&1 &
    # To re-enable vision: add `--mmproj "$MAIN_MMPROJ" \` between -m and --host above.
    wait_for "main" "$MAIN_PORT"
}

start_tiny() {
    if curl -s --max-time 2 "http://localhost:$TINY_PORT/v1/models" > /dev/null 2>&1; then
        echo "[llm] tiny already running"; return; fi
    echo "[llm] Starting tiny (8K context, parallel 2, 5090)..."
    CUDA_VISIBLE_DEVICES="$GPU_5090" \
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
