#!/bin/bash

# Load Configuration from .env.deploy
if [ -f .env.deploy ]; then
  source .env.deploy
else
  echo "Error: .env.deploy file not found!"
  echo "Please create a .env.deploy file with VM_IP, VM_USER, SSH_KEY, and DEST_DIR."
  exit 1
fi

echo "🚀 Starting Deployment to $VM_IP..."

# 1. Sync files to the VM (excluding unnecessary files)
echo "📦 Copying files to VM..."
rsync -avz --delete --progress \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'extension' \
  ./ $VM_USER@$VM_IP:$DEST_DIR/

# 2. Copy the production environment file
echo "🔐 Copying .env.production to server..."
scp -i $SSH_KEY .env.production $VM_USER@$VM_IP:$DEST_DIR/.env

# 3. Execute setup commands on the VM
echo "🔧 Running setup on VM..."
ssh -i $SSH_KEY $VM_USER@$VM_IP << 'EOF'
  cd ~/CareerCompass

  # Check if Docker is installed, install if not
  if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker..."
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2
    sudo usermod -aG docker $USER
    echo "✅ Docker installed! (You may need to log out and back in for permissions)"
  fi

  # Stop any existing containers
  echo "🛑 Stopping old containers..."
  sudo docker compose down

  # Rebuild and start the server, database, and redis
  echo "🚀 Building and starting new containers..."
  sudo docker compose build --no-cache server
  sudo docker compose up -d

  # Run Prisma migrations to ensure database schema is up to date
  echo "🗄️ Syncing database schema..."
  sudo docker compose exec -T server npx prisma db push --accept-data-loss

  echo "🎉 Deployment Successful! Server is running on port 3000."
EOF
