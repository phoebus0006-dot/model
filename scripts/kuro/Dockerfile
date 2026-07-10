FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libxml2-dev libxslt1-dev curl wget gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask beautifulsoup4 lxml playwright

RUN playwright install --with-deps chromium

COPY . .

EXPOSE 9192

CMD ["python", "main.py"]
