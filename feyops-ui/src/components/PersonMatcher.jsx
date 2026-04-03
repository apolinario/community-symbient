import { useState, useEffect, useMemo } from 'react'

const API_BASE = window.location.origin + '/api'

function PersonMatcher({ onClose }) {
  const [people, setPeople] = useState([])
  const [unmatched, setUnmatched] = useState([])
  const [nicknames, setNicknames] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('unmatched') // unmatched | nicknames
  const [newNickSlug, setNewNickSlug] = useState('')
  const [newNickName, setNewNickName] = useState('')

  const fetchAll = async () => {
    setLoading(true)
    const [pRes, uRes, nRes] = await Promise.all([
      fetch(`${API_BASE}/people`),
      fetch(`${API_BASE}/unmatched`),
      fetch(`${API_BASE}/nicknames`),
    ])
    const pData = await pRes.json()
    const uData = await uRes.json()
    const nData = await nRes.json()
    setPeople(pData.people || [])
    setUnmatched(uData.guests || [])
    setNicknames(nData.nicknames || [])
    setLoading(false)
  }

  useEffect(() => { fetchAll() }, [])

  const matchGuest = async (guest, slug) => {
    await fetch(`${API_BASE}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest, slug }),
    })
    fetchAll()
  }

  const skipGuest = async (guest) => {
    // Match to special '__skip__' to hide from unmatched list — or we can just ignore
    // For now, we'll match to a 'skip' marker
    await fetch(`${API_BASE}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest, slug: '__unlinked__' }),
    })
    fetchAll()
  }

  const addNickname = async () => {
    if (!newNickSlug || !newNickName) return
    await fetch(`${API_BASE}/nicknames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: newNickSlug, nickname: newNickName }),
    })
    setNewNickName('')
    fetchAll()
  }

  const removeNickname = async (slug, nickname) => {
    await fetch(`${API_BASE}/nicknames`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, nickname }),
    })
    fetchAll()
  }

  const filteredUnmatched = useMemo(() => {
    if (!search) return unmatched
    const s = search.toLowerCase()
    return unmatched.filter(u => u.guest.toLowerCase().includes(s))
  }, [unmatched, search])

  const findSuggestions = (guestName) => {
    const lower = guestName.toLowerCase().replace(/[^a-z ]/g, '')
    const parts = lower.split(/\s+/).filter(Boolean)

    return people
      .map(p => {
        const nameLower = p.name.toLowerCase().replace(/[^a-z ]/g, '')
        const slugLower = p.slug.toLowerCase()

        // Exact name match
        if (nameLower === lower) return { ...p, score: 100 }

        // Check if any part of the guest name matches parts of the person name
        const nameParts = nameLower.split(/\s+/)
        let partMatches = 0
        for (const part of parts) {
          if (part.length < 2) continue
          if (nameParts.some(np => np.startsWith(part) || part.startsWith(np))) partMatches++
          if (slugLower.includes(part)) partMatches++
        }

        // Check nicknames
        const personNicks = nicknames.filter(n => n.slug === p.slug)
        for (const nick of personNicks) {
          if (nick.nickname.toLowerCase() === lower) return { ...p, score: 95 }
          if (nick.nickname.toLowerCase().includes(lower) || lower.includes(nick.nickname.toLowerCase())) {
            partMatches += 2
          }
        }

        if (partMatches === 0) return null
        return { ...p, score: Math.min(90, partMatches * 25) }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  }

  if (loading) return <div className="matcher-overlay"><div className="matcher-modal"><p>Loading...</p></div></div>

  return (
    <div className="matcher-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="matcher-modal">
        <div className="matcher-header">
          <h2>Person Matching</h2>
          <div className="matcher-tabs">
            <button className={tab === 'unmatched' ? 'active' : ''} onClick={() => setTab('unmatched')}>
              Unmatched ({unmatched.length})
            </button>
            <button className={tab === 'nicknames' ? 'active' : ''} onClick={() => setTab('nicknames')}>
              Nicknames ({nicknames.length})
            </button>
          </div>
          <button className="close-btn" onClick={onClose}>X</button>
        </div>

        {tab === 'unmatched' && (
          <div className="matcher-content">
            <input
              type="text"
              placeholder="Filter guest names..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="matcher-search"
            />
            <div className="unmatched-list">
              {filteredUnmatched.map(u => (
                <UnmatchedRow
                  key={u.guest}
                  guest={u}
                  people={people}
                  suggestions={findSuggestions(u.guest)}
                  onMatch={matchGuest}
                  onSkip={skipGuest}
                />
              ))}
              {filteredUnmatched.length === 0 && (
                <p className="empty-state">
                  {unmatched.length === 0 ? 'All bookings are matched!' : 'No results for filter.'}
                </p>
              )}
            </div>
          </div>
        )}

        {tab === 'nicknames' && (
          <div className="matcher-content">
            <div className="nickname-form">
              <select value={newNickSlug} onChange={e => setNewNickSlug(e.target.value)}>
                <option value="">Select person...</option>
                {people.map(p => (
                  <option key={p.slug} value={p.slug}>{p.name}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Nickname..."
                value={newNickName}
                onChange={e => setNewNickName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addNickname()}
              />
              <button onClick={addNickname}>Add</button>
            </div>
            <div className="nickname-list">
              {nicknames.map(n => (
                <div key={`${n.slug}-${n.nickname}`} className="nickname-row">
                  <span className="nick-slug">{n.slug}</span>
                  <span className="nick-arrow">&rarr;</span>
                  <span className="nick-name">{n.nickname}</span>
                  <button className="nick-remove" onClick={() => removeNickname(n.slug, n.nickname)}>x</button>
                </div>
              ))}
              {nicknames.length === 0 && <p className="empty-state">No nicknames yet.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function UnmatchedRow({ guest, people, suggestions, onMatch, onSkip }) {
  const [expanded, setExpanded] = useState(false)
  const [manualSearch, setManualSearch] = useState('')

  const filteredPeople = manualSearch
    ? people.filter(p =>
        p.name.toLowerCase().includes(manualSearch.toLowerCase()) ||
        p.slug.includes(manualSearch.toLowerCase())
      ).slice(0, 10)
    : []

  const allOptions = expanded ? [...suggestions, ...filteredPeople.filter(fp => !suggestions.some(s => s.slug === fp.slug))] : suggestions.slice(0, 3)

  return (
    <div className="unmatched-row">
      <div className="unmatched-guest" onClick={() => setExpanded(!expanded)}>
        <span className="guest-label">{guest.guest}</span>
        <span className="guest-meta">{guest.count} booking{guest.count > 1 ? 's' : ''} ({guest.sources})</span>
      </div>
      <div className="match-options">
        {allOptions.map(s => (
          <button key={s.slug} className={`match-btn ${s.score >= 90 ? 'high' : s.score >= 50 ? 'medium' : 'low'}`} onClick={() => onMatch(guest.guest, s.slug)} title={s.slug}>
            {s.name} {s.score >= 90 ? '\u2713' : ''}
          </button>
        ))}
        {expanded && (
          <input
            type="text"
            placeholder="Search people..."
            value={manualSearch}
            onChange={e => setManualSearch(e.target.value)}
            className="manual-search"
            onClick={e => e.stopPropagation()}
          />
        )}
        <button className="skip-btn" onClick={() => onSkip(guest.guest)} title="Not a person / skip">
          Skip
        </button>
      </div>
    </div>
  )
}

export default PersonMatcher
