FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home athlete && mkdir /data && chown athlete /data
COPY *.py ./
COPY static ./static
USER athlete
ENV GENISPORT_DB=/data/genisport.db HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["python", "main.py"]
