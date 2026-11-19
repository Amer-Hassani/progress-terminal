"""Build the .vsix without npm: a zip with the VS Code manifest and the extension files.
Run from the repo root: python3 scripts/build-vsix.py  →  progress-terminal-<version>.vsix"""
import json
import os
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ['package.json', 'extension.js', 'setup.js', 'uninstall.js', 'icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE',
         'python/core.py', 'python/hook.py', 'python/progress.py', 'python/view.py', 'python/progress']
pkg = json.load(open(os.path.join(ROOT, 'package.json')))
tags = ','.join(pkg.get('keywords', []))
cats = ','.join(pkg.get('categories', []))

CONTENT_TYPES = ('<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 + ''.join('<Default Extension="%s" ContentType="%s"/>' % e for e in [
                     ('.json', 'application/json'), ('.js', 'application/javascript'), ('.py', 'text/plain'),
                     ('.png', 'image/png'), ('.md', 'text/markdown'), ('.vsixmanifest', 'text/xml'), ('', 'text/plain')])
                 + '</Types>')

MANIFEST = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}"/>
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(tags)}</Tags>
    <Categories>{escape(cats)}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg['engines']['vscode']}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{pkg['repository']['url']}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="{pkg['repository']['url']}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="{pkg['repository']['url']}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="{pkg['bugs']['url']}"/>
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="{pkg['homepage']}"/>
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>
'''

out = os.path.join(ROOT, '%s-%s.vsix' % (pkg['name'], pkg['version']))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CONTENT_TYPES)
    z.writestr('extension.vsixmanifest', MANIFEST)
    for f in FILES:
        info = zipfile.ZipInfo('extension/' + f, date_time=(2026, 1, 1, 0, 0, 0))
        info.external_attr = (0o755 if f == 'python/progress' else 0o644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, open(os.path.join(ROOT, f), 'rb').read())
print(out)
