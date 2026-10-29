# ⚽ Brasileirão 2026 • Simulador & Modelo Poisson (API ESPN)

Aplicação web moderna, interativa e responsiva para acompanhar a classificação em tempo real do **Campeonato Brasileiro Série A 2026** via API oficial da ESPN, calcular as probabilidades de rebaixamento dos clubes através da **Distribuição de Poisson** e de simulações **Monte Carlo**, além de permitir a simulação interativa de todos os confrontos restantes rodada a rodada.

---

## 🌟 Principais Recursos

- 📡 **Integração em Tempo Real com a API da ESPN:** Busca automática da tabela atualizada, estatísticas e escudos oficiais em alta resolução (`https://site.api.espn.com/apis/v2/sports/soccer/bra.1/standings`).
- 🚨 **Termômetro do Rebaixamento (Poisson):** Exibe as porcentagens de queda dos times ameaçados. **Filtro estrito:** clubes que já garantiram permanência matemática (0% de chance de queda) não aparecem na lista de risco!
- ⚽ **Simulador Interativo de Rodadas:**
  - Simule qualquer partida restante clicando nos botões de resultado rápido (Vitória Casa, Empate, Vitória Fora) ou inserindo o placar exato.
  - A tabela e as probabilidades de rebaixamento são recalculadas **instantaneamente** a cada resultado simulado!
- 🎯 **Probabilidades Poisson para Cada Confronto:** Cada card de jogo exibe a estimativa probabilística de vitória mandante, empate e vitória visitante baseada nos índices de ataque e defesa dos clubes e fator casa.
- ⚡ **Simulação Automática Completa:** Botão para simular todas as 56 partidas restantes de uma só vez utilizando as distribuições de Poisson.
- 🎨 **Design Moderno e Imersivo:** Estilo visual "Brazilian Stadium Dark" com cores vivas (verde esmeralda neon, ouro brasileiro, azul elétrico e vermelho alerta), cards de vidro e escudos de alta resolução.
- 📱 **Totalmente Responsivo:** Funciona em celulares, tablets e computadores.

---

## 📐 Modelo Matemático: Distribuição de Poisson

O número de gols marcados por uma equipe é modelado por:

$$P(X = k) = \frac{\lambda^k e^{-\lambda}}{k!}$$

Onde $\lambda$ representa a taxa esperada de gols (xG) da equipe no confronto, estimada através da:
1. Força de ataque do clube ($\alpha_i$)
2. Fragilidade defensiva do adversário ($\beta_j$)
3. Média de gols da liga e fator mando de campo (+15% em casa, -15% fora).

Para o cálculo de rebaixamento, são executadas **8.000 iterações de Monte Carlo** aplicando todos os critérios oficiais de desempate da CBF (Pontos > Vitórias > Saldo de Gols > Gols Pró).

---

## 🚀 Como Publicar no GitHub Pages

Consulte o arquivo [`INSTRUCOES_GITHUB.txt`](INSTRUCOES_GITHUB.txt) para o guia passo a passo em texto com instruções para publicar este projeto gratuitamente com uma URL pública no GitHub Pages, Vercel ou Netlify.
