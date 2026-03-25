# Gia Desktop Notetaker


```shell


# Install
npm install

# Run
npm start


# Reset Desktop Recording Permissions
sudo tccutil reset All com.gia.desktop-recording

# Reset WebStorm Permissions
sudo tccutil reset All com.jetbrains.WebStorm

# Reset VSCode Permissions
sudo tccutil reset All com.microsoft.VSCode 

# Remove auth tokens
rm "$HOME/Library/Application Support/Gia/auth.tokens.json"
```