# Deploy on Render

The repository's `render.yaml` is a minimal Render Blueprint for the
OpenJarvis API server. It builds `deploy/docker/Dockerfile`, binds the server to
Render's default web-service port (`10000`), and routes inference through an
OmniRoute gateway with ElevenLabs voice output. See
[OmniRoute + ElevenLabs on Render](omniroute-render.md) for the full setup.

## Create the service

1. Open Render's **New Blueprint Instance** flow and select your OpenJarvis
   fork.
2. Provide `OMNIROUTE_HOST`, `OMNIROUTE_API_KEY`, `OPENJARVIS_MODEL` and
   `ELEVENLABS_API_KEY` when Render asks for the Blueprint secrets.
3. Apply the Blueprint and wait for `/health` to become healthy.
4. Retrieve the generated `OPENJARVIS_API_KEY` from the Render dashboard and
   send it as `Authorization: Bearer <key>` with API requests.

The Blueprint pins both the `PORT` environment variable and the server's
`--port` argument to `10000`. Render's Docker command does not expand `$PORT`,
so if you customize the service port, update both values in `render.yaml`.

The Blueprint's `OPENJARVIS_ENGINE` and `OPENJARVIS_MODEL` variables replace the
old `--engine`/`--model` command arguments, so the engine or model can be changed
from the Render dashboard without editing `render.yaml`. To use a different
engine (for example the OpenAI cloud engine), change `OPENJARVIS_ENGINE`, set
that engine's credentials, and install its inference extra in the image.

## Storage and free-instance limits

!!! warning "Free instances do not preserve OpenJarvis data"
    Render's free web-service filesystem is ephemeral. Everything written to
    `/home/openjarvis/.openjarvis` — including configuration, credentials,
    connector tokens, local databases, and learned state — is lost whenever
    the service restarts, spins down, or redeploys. Free instances also spin
    down after periods without inbound traffic and are not suitable for
    production or durable personal-assistant state.

For durable state, upgrade the service to a paid instance and attach a
persistent disk at `/home/openjarvis/.openjarvis`, or configure the relevant
feature to use an external managed datastore. Only data below a persistent
disk's mount path survives a restart; attaching a disk elsewhere does not
preserve the default OpenJarvis home.

The Blueprint intentionally does not declare a disk because Render does not
support persistent disks on free services.
