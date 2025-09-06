FROM node:20-bullseye

# Instala Python, pip, ffmpeg e yt-dlp
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg \
    && pip3 install -U yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia package.json e package-lock.json
COPY package*.json ./

# Instala dependências
RUN npm install

# Copia o resto do projeto
COPY . .

# Expõe a porta que o backend usa
EXPOSE 3001

# Comando para iniciar o app
CMD ["npm", "start"]
