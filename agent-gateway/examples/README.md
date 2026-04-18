# Examples

## `simple-agent.ts`

A minimal autonomous agent that does the full DLF pipeline through the gateway:

1. Checks its balance
2. Gathers 5 images for a query
3. Labels them with OpenRouter Gemma
4. Starts a YOLO training job
5. Polls until the job finishes
6. Downloads `best.pt` to disk

### Run it

```bash
# Ask the admin for a key first; or mint your own via /v1/admin/keys.
export DLF_KEY=dlf_…
npx tsx examples/simple-agent.ts "swimming pools"
```

Expected output:

```
→ agent starting: query="swimming pools" epochs=10
  balance: 200000 mcents ($2.00000), xp=0, level=0
  gather: got 5 images; balance=199900mc xp=10
  label[0]: detections=3 elapsed=0.8s balance=199700mc
  label[1]: detections=2 elapsed=1.4s balance=199500mc
  …
  train: job_id=abc123… balance=196800mc new_badges=["first_label","first_train"]
  [  0] status=IN_QUEUE
  [ 14] status=IN_PROGRESS
  [ 22] status=COMPLETED
  downloaded 6245000 bytes → ./best_abc123.pt
→ done. final: L2 280XP, balance $1.96800, badges=["first_label","first_train"]
```

Total spend: **~3100 mcents ($0.031)** per run.
