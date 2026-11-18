/* sdfdrop landing motion — external file (CSP allows no inline scripts).
 * Progressive enhancement: if this file fails, the page is fully usable. */
(() => {
  'use strict';
  const landing = document.getElementById('landing');
  if (!landing) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- scroll progress bar ----
  const bar = document.getElementById('scrollProgress');
  const onScroll = () => {
    if (!bar) return;
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = (max > 0 ? Math.min(100, (scrollY / max) * 100) : 0) + '%';
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  onScroll();

  // ---- staggered reveals as sections enter the viewport ----
  const selector = '.info-section>.section-kicker,.info-section>h2,.steps article,' +
    '.feature-intro,.feature-grid article,.final-cta';
  const targets = [...landing.querySelectorAll(selector)];
  if ('IntersectionObserver' in window && !reduce) {
    targets.forEach(el => el.setAttribute('data-reveal', ''));
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    targets.forEach((el, i) => {
      el.style.transitionDelay = (i % 4) * 90 + 'ms';
      io.observe(el);
    });
  } else {
    targets.forEach(el => el.classList.add('is-visible'));
  }

  if (reduce) return;

  // ---- pointer parallax + cursor glow on the hero illustration ----
  const hero = landing.querySelector('.hero-visual');
  const cursor = landing.querySelector('.hero-cursor');
  if (hero) {
    let raf = 0, px = 0, py = 0;
    const paint = () => {
      raf = 0;
      hero.style.setProperty('--px', px + 'px');
      hero.style.setProperty('--py', py + 'px');
    };
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      px = (x - 0.5) * 18;
      py = (y - 0.5) * 14;
      if (cursor) {
        cursor.style.setProperty('--mx', (x * 100) + '%');
        cursor.style.setProperty('--my', (y * 100) + '%');
        cursor.style.opacity = '1';
      }
      if (!raf) raf = requestAnimationFrame(paint);
    }, { passive: true });
    hero.addEventListener('pointerleave', () => {
      px = 0; py = 0;
      if (cursor) cursor.style.opacity = '0';
      if (!raf) raf = requestAnimationFrame(paint);
    }, { passive: true });
  }

  // ---- feature cards: soft glow follows the pointer ----
  landing.querySelectorAll('.feature-grid article').forEach(card => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--cx', (((e.clientX - r.left) / r.width) * 100) + '%');
      card.style.setProperty('--cy', (((e.clientY - r.top) / r.height) * 100) + '%');
    }, { passive: true });
  });
})();
