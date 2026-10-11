FROM python:3.11-slim

WORKDIR /app

# Laya decision service for humanize-ai. Requires USE_TF=0 to avoid the
# transformers/tensorflow import deadlock.
ENV USE_TF=0
ENV PYTHONUNBUFFERED=1

COPY server.py /app/server.py

# ~2GB of pip deps (torch CPU + transformers + laya). This is the long step.
RUN pip install --no-cache-dir laya

# Prewarm the model weights into the image so runtime cold starts are fast
# (~800MB cached under /root/.cache/huggingface). If this step ever fails on
# build, delete it and preload will happen at boot instead.
RUN python -c "from laya import Router; Router(preload=True, device='cpu')"

EXPOSE 7860

CMD ["python", "server.py"]