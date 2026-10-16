# Tripwire API image.
#
# NOTE: Docker is not installed on the machine this repository was prepared on,
# so this image has NOT been built or run here. It is provided as a correct,
# complete definition for a host that has Docker.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install dependencies first so the layer is cached across code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the package and project files (docker-compose sets the runtime env).
COPY . .

# Run as a non-root user that owns the app directory (the JSON fallback store
# writes data/graph.json under /app).
RUN useradd --create-home --uid 10001 tripwire \
    && chown -R tripwire:tripwire /app
USER tripwire

EXPOSE 8000

# docker-compose overrides the store with TRIPWIRE_STORE=falkordb + FALKOR_HOST;
# uvicorn serves the module-level `app` from tripwire.api.app.
CMD ["uvicorn", "tripwire.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
