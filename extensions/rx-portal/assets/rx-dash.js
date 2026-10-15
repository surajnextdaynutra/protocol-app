/* Rx Portal - dashboard app blocks.

   One renderer for the five dashboard blocks (practice / clinic / physician /
   sales rep / finance). Each block's Liquid prints a mount element carrying
   the viewer's ids; this script calls the app (/apps/rx/...) and draws
   summary tiles and tables. The app checks the ids against the logged-in
   customer, so nothing here is trusted. */
(function () {
  'use strict';

  /* ------------------------------ helpers ------------------------------- */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    [].concat(children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function get(obj, path) {
    return String(path).split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  var num = function (v) { return Number(v) || 0; };

  function makeFormat(currency) {
    var moneyFmt;
    try { moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }); }
    catch (e) { moneyFmt = { format: function (n) { return '$' + n.toFixed(2); } }; }
    return {
      money: function (v) { return v == null ? '-' : moneyFmt.format(num(v)); },
      int: function (v) { return num(v).toLocaleString(); },
      pct: function (v) { return num(v) + '%'; },
      date: function (v) {
        if (!v) return '';
        var d = new Date(v);
        return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      },
      text: function (v) { return v == null ? '' : String(v); }
    };
  }

  // Raw Shopify delivery status -> label (mirrors the app's own mapping).
  function statusLabel(row) {
    var d = row.deliveryStatus;
    if (!d) return row.orderStatus || row.status || '';
    if (row.orderStatus) return row.orderStatus;
    return String(d).charAt(0) + String(d).slice(1).toLowerCase().replace(/_/g, ' ');
  }
  var STATUS_KIND = {
    delivered: 'good', paid: 'good', purchased: 'good', fulfilled: 'good',
    pending: 'warning', open: 'warning', sent: 'warning', opened: 'warning', created: 'warning',
    'checkout started': 'warning', 'in transit': 'warning', 'tracking added': 'warning',
    'out for delivery': 'warning', unfulfilled: 'warning',
    abandoned: 'serious', expired: 'critical', deleted: 'critical', 'delivery failed': 'critical'
  };
  // A status is a coloured dot PLUS its label - never colour alone.
  function statusCell(label) {
    if (!label) return document.createTextNode('');
    var kind = STATUS_KIND[String(label).toLowerCase()] || 'neutral';
    return h('span', { class: 'rxd-status' }, [h('span', { class: 'rxd-dot rxd-dot--' + kind, 'aria-hidden': 'true' }), label]);
  }

  function toCsv(columns, rows) {
    var esc = function (v) {
      v = v == null ? '' : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [columns.map(function (c) { return esc(c.h); }).join(',')];
    rows.forEach(function (r) {
      lines.push(columns.map(function (c) {
        var v = c.get(r);
        if (c.type === 'date' && v) v = new Date(v).toISOString().slice(0, 10);
        return esc(v);
      }).join(','));
    });
    return lines.join('\r\n');
  }
  function download(name, text) {
    var a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  var col = function (heading, key, type) {
    return { h: heading, type: type || 'text', get: typeof key === 'function' ? key : function (r) { return get(r, key); } };
  };

  /* ------------------------- what each role shows ------------------------ */
  var SALES_TILES = function (d) {
    return [
      { label: 'Sales this month', value: get(d, 'sales.thisMonth'), type: 'money' },
      { label: 'Sales last month', value: get(d, 'sales.lastMonth'), type: 'money' },
      { label: 'Sales in this period', value: get(d, 'sales.allTime'), type: 'money', hint: num(get(d, 'sales.orders')) + ' orders' },
      { label: 'Protocols written', value: d.totalPrescriptions, type: 'int' },
      { label: 'Pending checkouts', value: d.pendingCheckouts, type: 'int' },
      { label: 'Active orders this month', value: d.activeOrders, type: 'int', hint: num(d.shippedOrders) + ' delivered' }
    ];
  };
  var TOP_PRODUCTS = function (d) {
    return { title: 'Top products', rows: d.topProducts || [], columns: [col('Product', 'name'), col('Units', 'qty', 'int')] };
  };
  var PAYOUTS = function (rows) {
    return {
      title: 'Payment history', rows: rows || [],
      columns: [col('Period', 'period'), col('Status', 'status', 'status'), col('Amount', 'amount', 'money'),
        col('Date paid', 'datePaid'), col('Transaction #', 'transactionNum')]
    };
  };

  var ROLES = {
    practice: {
      endpoint: 'practice', action: 'dashboard',
      params: function (ids) { return { practice: ids.practice }; },
      needs: 'practice',
      tiles: function (d) {
        return SALES_TILES(d).concat([
          { label: 'Practice earnings', value: d.practiceCommissionTotal, type: 'money' },
          { label: 'Clinic earnings', value: d.clinicCommissionTotal, type: 'money' },
          { label: 'Physician earnings', value: d.physicianCommissionTotal, type: 'money' },
          { label: 'Paid to the practice', value: get(d, 'commission.paid'), type: 'money' },
          { label: 'Open this month', value: get(d, 'commission.open'), type: 'money' },
          { label: 'Pending payment', value: get(d, 'commission.pending'), type: 'money' }
        ]);
      },
      tables: function (d) {
        return [
          { title: 'Clinics', rows: d.clinics || [], columns: [
            col('Clinic', function (r) { return r.name || r.id; }), col('Protocols written', 'created', 'int'),
            col('Orders', 'purchased', 'int'), col('Units', 'bottles', 'int'), col('Sales', 'earning', 'money'),
            col('Physician earnings', 'physicianCommission', 'money'), col('Clinic earnings', 'clinicCommission', 'money'),
            col('Practice earnings', 'practiceCommission', 'money')] },
          { title: 'Physicians', rows: d.doctors || [], columns: [
            col('Physician', function (r) { return r.name || r.id; }), col('Email', 'email'),
            col('Protocols written', 'created', 'int'), col('Orders', 'purchased', 'int'), col('Units', 'bottles', 'int'),
            col('Sales', 'earning', 'money'), col('Physician earnings', 'physicianCommission', 'money')] },
          { title: 'Recent activity', rows: d.recent || [], columns: [
            col('Date', 'ts', 'date'), col('Order', 'orderName'), col('Patient', 'name'), col('Items', 'items'),
            col('Status', statusLabel, 'status'), col('Total', 'total', 'money'),
            col('Physician earnings', 'physicianCommission', 'money'), col('Clinic earnings', 'clinicCommission', 'money')] },
          PAYOUTS(d.payouts), TOP_PRODUCTS(d)
        ];
      }
    },

    clinic: {
      endpoint: 'clinic', action: 'dashboard',
      params: function (ids) { return { clinic: ids.clinic }; },
      needs: 'clinic',
      tiles: function (d) {
        return SALES_TILES(d).concat([
          { label: 'Clinic earnings', value: get(d, 'commission.total'), type: 'money' },
          { label: 'Paid', value: get(d, 'commission.paid'), type: 'money' },
          { label: 'Pending payment', value: get(d, 'commission.pending'), type: 'money' }
        ]);
      },
      tables: function (d) {
        return [
          { title: 'Physicians', rows: d.doctors || [], columns: [
            col('Physician', function (r) { return r.name || r.id; }), col('Email', 'email'),
            col('Protocols written', 'created', 'int'), col('Orders', 'purchased', 'int'), col('Units', 'bottles', 'int'),
            col('Sales', 'revenue', 'money'), col('Physician earnings', 'earning', 'money'), col('Clinic earnings', 'commission', 'money')] },
          { title: 'Recent activity', rows: d.recent || [], columns: [
            col('Date', 'ts', 'date'), col('Order', 'orderName'), col('Patient', 'name'), col('Physician', 'doctor'),
            col('Units', 'totalItems', 'int'), col('Status', 'status', 'status'), col('Total', 'total', 'money'),
            col('Clinic earnings', 'clinicEarning', 'money')] },
          TOP_PRODUCTS(d)
        ];
      }
    },

    physician: {
      endpoint: 'physician', action: 'dashboard',
      params: function (ids) { return { doctor: ids.doctor, practice: ids.practice }; },
      needs: 'doctor',
      tiles: function (d) {
        return SALES_TILES(d).concat([
          { label: 'Active subscriptions', value: d.activeSubscriptions, type: 'int' },
          { label: 'Earnings', value: get(d, 'commission.total'), type: 'money' },
          { label: 'Paid', value: d.payoutPaid != null ? d.payoutPaid : get(d, 'commission.paid'), type: 'money' },
          { label: 'Pending payment', value: d.payoutPending != null ? d.payoutPending : get(d, 'commission.pending'), type: 'money' }
        ]);
      },
      tables: function (d) {
        return [
          { title: 'Orders and protocols', rows: d.recent || [], columns: [
            col('Date', 'ts', 'date'), col('Order', 'orderName'), col('Patient', 'name'), col('Items', 'items'),
            col('Status', statusLabel, 'status'), col('Total', 'total', 'money'),
            col('Earnings', function (r) { return r.commissionEligible ? r.commission : null; }, 'money')] },
          d.payouts ? PAYOUTS(d.payouts) : null, TOP_PRODUCTS(d)
        ];
      }
    },

    rep: {
      endpoint: 'rep', action: 'repdash',
      params: function (ids) { return { rep: ids.rep }; },
      needs: 'rep',
      tiles: function (d) {
        return [
          { label: 'Orders', value: get(d, 'totals.orders'), type: 'int' },
          { label: 'Sales', value: get(d, 'totals.sales'), type: 'money' },
          { label: 'Units sold', value: get(d, 'totals.units'), type: 'int' },
          { label: 'Physicians', value: get(d, 'totals.doctors'), type: 'int', hint: num(get(d, 'totals.clinics')) + ' clinics' },
          { label: 'Commission earned', value: get(d, 'commission.total'), type: 'money' },
          { label: 'Paid', value: get(d, 'commission.paid'), type: 'money' },
          { label: 'Open this month', value: get(d, 'commission.open'), type: 'money' },
          { label: 'Pending payment', value: get(d, 'commission.pending'), type: 'money' }
        ];
      },
      tables: function (d) {
        return [
          { title: 'Practices', rows: d.practices || [], columns: [
            col('Practice', function (r) { return r.name || r.id; }), col('Protocols written', 'writtenProtocols', 'int'),
            col('Completed', 'completedProtocols', 'int'), col('Conversion', 'conversion', 'pct'), col('Orders', 'orders', 'int'),
            col('Units', 'units', 'int'), col('Sales', 'sales', 'money'), col('Commission', 'commission', 'money')] },
          { title: 'Physicians', rows: d.doctors || [], columns: [
            col('Physician', 'name'), col('Email', 'email'), col('Protocols written', 'writtenProtocols', 'int'),
            col('Conversion', 'conversion', 'pct'), col('Orders', 'orders', 'int'), col('Units', 'units', 'int'),
            col('Sales', 'sales', 'money'), col('Commission', 'commission', 'money')] },
          { title: 'Orders', rows: d.orders || [], columns: [
            col('Date', 'ts', 'date'), col('Order', 'order'), col('Practice', 'practiceName'), col('Physician', 'doctorName'),
            col('Units', 'units', 'int'), col('Status', 'orderStatus', 'status'), col('Total', 'amount', 'money'),
            col('Commission', 'commission', 'money')] },
          { title: 'Payments', rows: get(d, 'commission.payments') || [], columns: [
            col('Period', 'note'), col('Status', 'status', 'status'), col('Amount', 'amount', 'money'), col('Reference', 'reference')] }
        ];
      }
    },

    finance: {
      endpoint: 'finance', action: 'admindash',
      params: function () { return {}; },
      needs: null,
      tiles: function (d) {
        return [
          { label: 'Commission in this period', value: get(d, 'totals.revenueAllTime'), type: 'money', hint: num(get(d, 'totals.ordersAllTime')) + ' orders' },
          { label: 'This month', value: get(d, 'totals.revenueThisMonth'), type: 'money' },
          { label: 'Last month', value: get(d, 'totals.revenueLastMonth'), type: 'money' },
          { label: 'Practices', value: get(d, 'totals.practiceCount'), type: 'int', hint: num(get(d, 'totals.physicianCount')) + ' physicians' },
          { label: 'Owed to practices and physicians', value: get(d, 'commission.total'), type: 'money' },
          { label: 'Paid', value: get(d, 'commission.paid'), type: 'money' },
          { label: 'Pending payment', value: get(d, 'commission.pending'), type: 'money' },
          { label: 'Sales rep commission pending', value: get(d, 'commission.repPending'), type: 'money' }
        ];
      },
      tables: function (d) {
        var entity = [col('Orders', 'orders', 'int'), col('Commission pool', 'revenue', 'money'), col('Earned', 'earned', 'money'),
          col('Paid', 'paid', 'money'), col('Pending', 'pending', 'money')];
        return [
          { title: 'Payouts', rows: d.payouts || [], columns: [
            col('Month', 'month'), col('Role', 'role'), col('Name', 'name'), col('ID', 'id'), col('Amount', 'amount', 'money'),
            col('Status', 'status', 'status'), col('Date paid', 'datePaid'), col('Confirmation #', 'confirmationNum')] },
          { title: 'Practices', rows: d.practices || [], columns: [col('Practice', 'name'), col('Clinics', 'clinicCount', 'int'), col('Physicians', 'doctorCount', 'int')].concat(entity) },
          { title: 'Physicians', rows: d.physicians || [], columns: [col('Physician', 'name'), col('Practice', 'practiceName')].concat(entity) },
          { title: 'Clinics', rows: d.clinics || [], columns: [col('Clinic', 'name'), col('Practice', 'practiceName')].concat(entity) },
          { title: 'Sales reps', rows: d.reps || [], columns: [
            col('Rep', 'name'), col('Orders', 'orders', 'int'), col('New clients', 'newClients', 'int'),
            col('Earned', 'earned', 'money'), col('Paid', 'paid', 'money'), col('Pending', 'pending', 'money')] },
          { title: 'Orders', rows: d.orders || [], columns: [
            col('Date', 'ts', 'date'), col('Order', 'order'), col('Practice', 'practiceName'), col('Physician', 'doctorName'),
            col('Delivery', 'deliveryStatus', 'status'), col('Order total', 'total', 'money'), col('Physician', 'doctorAmount', 'money'),
            col('Clinic', 'clinicAmount', 'money'), col('Practice', 'practiceAmount', 'money')] }
        ];
      }
    }
  };

  /* ------------------------------- render ------------------------------- */
  var PAGE = 15;

  function renderTable(def, fmt) {
    var shown = PAGE;
    var body = h('tbody');
    var more = h('button', { type: 'button', class: 'rxd-link' });
    function draw() {
      body.textContent = '';
      def.rows.slice(0, shown).forEach(function (r) {
        body.appendChild(h('tr', null, def.columns.map(function (c) {
          var v = c.get(r);
          var numeric = c.type === 'money' || c.type === 'int' || c.type === 'pct';
          var content = c.type === 'status' ? statusCell(v) : (fmt[c.type] || fmt.text)(v);
          return h('td', { class: numeric ? 'rxd-num' : null }, [content]);
        })));
      });
      more.textContent = 'Show all ' + def.rows.length;
      more.hidden = shown >= def.rows.length;
    }
    more.addEventListener('click', function () { shown = def.rows.length; draw(); });
    draw();

    var head = h('thead', null, [h('tr', null, def.columns.map(function (c) {
      var numeric = c.type === 'money' || c.type === 'int' || c.type === 'pct';
      return h('th', { scope: 'col', class: numeric ? 'rxd-num' : null, text: c.h });
    }))]);
    return h('section', { class: 'rxd-card' }, [
      h('div', { class: 'rxd-card-head' }, [
        h('h3', { class: 'rxd-h3', text: def.title + ' (' + def.rows.length + ')' }),
        def.rows.length ? h('button', {
          type: 'button', class: 'rxd-link',
          onclick: function () { download(def.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.csv', toCsv(def.columns, def.rows)); }
        }, ['Download CSV']) : null
      ]),
      def.rows.length
        ? h('div', { class: 'rxd-scroll', tabindex: '0', role: 'region', 'aria-label': def.title }, [h('table', { class: 'rxd-table' }, [head, body])])
        : h('p', { class: 'rxd-empty', text: 'Nothing to show for this period.' }),
      more
    ]);
  }

  function mount(root) {
    var role = ROLES[root.getAttribute('data-rx-dash')];
    if (!role || root.__rxd) return;
    root.__rxd = true;
    var proxy = (root.getAttribute('data-proxy') || (window.RxPortal && window.RxPortal.proxy) || '/apps/rx').replace(/\/+$/, '');
    var ids = {
      practice: root.getAttribute('data-practice') || '', clinic: root.getAttribute('data-clinic') || '',
      doctor: root.getAttribute('data-doctor') || '', rep: root.getAttribute('data-rep') || ''
    };
    var fmt = makeFormat(root.getAttribute('data-currency'));
    var days = root.getAttribute('data-days') || '0';
    var content = root.querySelector('[data-rxd-content]');

    function message(text) {
      content.textContent = '';
      content.appendChild(h('p', { class: 'rxd-message', text: text }));
    }
    if (root.getAttribute('data-logged-in') !== 'true') return message(root.getAttribute('data-login-text') || 'Please log in to view this dashboard.');
    if (role.needs && !ids[role.needs]) return message(root.getAttribute('data-noaccess-text') || 'This dashboard is not available for your account.');

    var range = h('select', { class: 'rxd-select', 'aria-label': 'Period' },
      [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['0', 'All time']].map(function (o) {
        return h('option', { value: o[0], selected: o[0] === days ? 'selected' : null, text: o[1] });
      }));
    var refresh = h('button', { type: 'button', class: 'rxd-btn', text: 'Refresh' });
    var stamp = h('span', { class: 'rxd-muted', 'aria-live': 'polite' });
    root.querySelector('[data-rxd-tools]').append(range, refresh, stamp);

    var seq = 0;
    function load() {
      var mine = ++seq;
      root.classList.add('rxd-loading');
      var params = role.params(ids);
      params.action = role.action;
      params.days = range.value;
      var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k] || ''); }).join('&');
      fetch(proxy + '/' + role.endpoint + '?' + qs, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (mine !== seq) return;
          root.classList.remove('rxd-loading');
          if (!d || d.ok === false) return message((d && d.error) || 'The dashboard could not be loaded.');
          content.textContent = '';
          content.appendChild(h('div', { class: 'rxd-tiles' }, role.tiles(d).map(function (t) {
            return h('div', { class: 'rxd-tile' }, [
              h('div', { class: 'rxd-tile-label', text: t.label }),
              h('div', { class: 'rxd-tile-value', text: (fmt[t.type] || fmt.text)(t.value) }),
              t.hint ? h('div', { class: 'rxd-tile-hint', text: t.hint }) : null
            ]);
          })));
          role.tables(d).forEach(function (def) { if (def) content.appendChild(renderTable(def, fmt)); });
          stamp.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        })
        .catch(function () {
          if (mine !== seq) return;
          root.classList.remove('rxd-loading');
          message('The dashboard could not be loaded. Please try again.');
        });
    }
    range.addEventListener('change', load);
    refresh.addEventListener('click', load);
    load();
  }

  function init() { [].forEach.call(document.querySelectorAll('[data-rx-dash]'), mount); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  document.addEventListener('shopify:section:load', init);
})();
