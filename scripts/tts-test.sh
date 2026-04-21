#!/bin/bash
# Quick TTS API test — generates speech and plays it
#
# Usage:
#   ./scripts/tts-test.sh "Hello from the château"
#   ./scripts/tts-test.sh "Hello" clone:iannis          # voice library clone
#   ./scripts/tts-test.sh "Hello" /path/to/voice.wav    # voice file clone

TTS_API="http://localhost:8000"
TEXT="${1:-Hello from Feÿtopia, this is a test broadcast.}"
VOICE="${2:-}"
OUTPUT="/tmp/tts-test-$(date +%s).wav"

echo "TTS API: $TTS_API"
echo "Text:    $TEXT"
echo "Voice:   ${VOICE:-random}"
echo ""

# Build JSON body
if [[ "$VOICE" == clone:* ]]; then
  # Voice library clone (fast, ~2.5s)
  BODY=$(python3 -c "
import json
print(json.dumps({
    'model': 'qwen3-tts',
    'voice': '$VOICE',
    'input': '''$TEXT''',
    'response_format': 'wav'
}))
")
elif [[ -n "$VOICE" && -f "$VOICE" ]]; then
  # Voice file clone (slow, 30-120s)
  BODY=$(python3 -c "
import json
print(json.dumps({
    'model': 'qwen3-tts',
    'voice': 'default',
    'input': '''$TEXT''',
    'response_format': 'wav',
    'voice_path': '$VOICE',
    'ref_text': 'This is a reference text for voice cloning.'
}))
")
else
  # Default voice
  BODY=$(python3 -c "
import json
print(json.dumps({
    'model': 'qwen3-tts',
    'voice': 'default',
    'input': '''$TEXT''',
    'response_format': 'wav'
}))
")
fi

echo "Request body:"
echo "$BODY" | python3 -m json.tool
echo ""
echo "Calling $TTS_API/v1/audio/speech ..."

HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT" \
  -X POST "$TTS_API/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --max-time 120)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: HTTP $HTTP_CODE"
  cat "$OUTPUT"
  rm -f "$OUTPUT"
  exit 1
fi

SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT" 2>/dev/null)
echo "Success! Saved to $OUTPUT ($SIZE bytes)"
echo ""
echo "Play with:  aplay $OUTPUT"
echo "Or copy:    scp $(hostname):$OUTPUT ."
