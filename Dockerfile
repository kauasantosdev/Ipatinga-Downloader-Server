# Começa com Node.js (versão 20) e sistema Debian
FROM node:20-bullseye

# Instala Python, pip, ffmpeg e yt-dlp
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg \
    && pip3 install -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Define a pasta de trabalho dentro do container
WORKDIR /app

# Copia package.json e instala dependências do Node
COPY package*.json ./
RUN npm install

# Copia o resto do seu projeto
COPY . .

# Expõe a porta que seu backend usa
EXPOSE 3001

# Comando que o Railway vai rodar
CMD ["npm", "start"]
