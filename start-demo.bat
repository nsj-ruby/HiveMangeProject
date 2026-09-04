@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 客户声音掘金 Demo - 数据组合分析及开放能力
set NODE_NO_WARNINGS=1
echo.
echo ============================================================
echo  客户声音掘金 · 数据组合分析及开放能力 Demo
echo  访问地址: http://127.0.0.1:8610
echo  (内置演示数据源开箱即用；如需 MySQL 请先 npm install mysql2)
echo ============================================================
echo.
node server.js
pause
