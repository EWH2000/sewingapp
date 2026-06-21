# sewingapp production image. Rootless-friendly: non-root user, serves uvicorn
# directly (no --reload). Build:  podman build -t sewingapp .
FROM docker.io/library/python:3.14-slim

# Non-root user inside the container (defense in depth atop rootless Podman).
RUN useradd --create-home --uid 10001 app

WORKDIR /app

# Deps first, in their own layer, so editing app code doesn't bust the pip layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code (Python + templates + static incl. vendored pdf-lib).
COPY app/ ./app/

# Data dir for the mounted volume (the SQLite file lives here).
RUN mkdir -p /data && chown -R app:app /data

USER app
ENV SEWING_DB_PATH=/data/sewing.db
EXPOSE 8006

# Liveness is defined in the Quadlet unit (HealthCmd=), not here — an
# image-level HEALTHCHECK is ignored by Podman's default OCI image format.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8006"]
