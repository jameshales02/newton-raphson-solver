import numpy as np
import matplotlib.pyplot as plt
from newton_solve import newton_solve

# -----------------------------
# Problem setup
# -----------------------------
A = np.array([0.0, 0.0])
B = np.array([1.0, 0.0])
L = np.linalg.norm(B - A)
W = 1.0

# Choose N values to compare
N_values = [5, 10, 20, 50]

# -----------------------------
# Analytical catenary (fit to your data)
# -----------------------------
def catenary(x, a):
    return a * np.cosh((x - L/2)/a) - a * np.cosh(L/(2*a))

# Rough fit for 'a' (not exact but sufficient visually)
a = 0.2   # you can tweak slightly if needed

x_cont = np.linspace(0, L, 500)
y_cont = catenary(x_cont, a)

# -----------------------------
# Solve and plot discrete chains
# -----------------------------
plt.figure()

for N in N_values:

    total_length = 1.20 * L
    s = total_length / N

    def unpack_vars(v):
        npos = 2 * (N - 1)
        coords = v[:npos]
        T = v[npos:]

        r = [A]
        for k in range(N - 1):
            xk = coords[2 * k]
            yk = coords[2 * k + 1]
            r.append(np.array([xk, yk]))
        r.append(B)

        return r, T

    def unit(vec):
        n = np.linalg.norm(vec)
        if n == 0:
            return np.array([0.0, 0.0]), 0.0
        return vec / n, n

    def F(v):
        r, T = unpack_vars(v)

        e = []
        Lk = []
        for k in range(N):
            ek, lk = unit(r[k+1] - r[k])
            e.append(ek)
            Lk.append(lk)

        c_len = [Lk[k] - s for k in range(N)]

        c_fb = []
        for j in range(1, N):
            fb = T[j-1]*e[j-1] - T[j]*e[j] + np.array([0.0, -W])
            c_fb.extend([fb[0], fb[1]])

        return np.array(c_len + c_fb)

    def initial_guess():
        x_lin = np.linspace(A[0], B[0], N+1)
        y_lin = np.linspace(A[1], B[1], N+1)

        sag = 0.1 * L
        x_int = x_lin[1:-1]
        y_lin[1:-1] -= sag * ((x_int - A[0]) * (B[0] - x_int)) / (0.25*L*L)

        coords = []
        for k in range(1, N):
            coords.extend([x_lin[k], y_lin[k]])

        T0 = [1.0]*N
        return np.array(coords + T0)

    # Solve
    x0 = initial_guess()
    sol, info = newton_solve(F, x0, damping=False)

    r, _ = unpack_vars(sol)

    X = [ri[0] for ri in r]
    Y = [ri[1] for ri in r]

    plt.plot(X, Y, marker='o', label=f"N={N}")

# Plot analytical catenary
plt.plot(x_cont, y_cont, 'k--', linewidth=2, label="Catenary")

plt.xlabel("x")
plt.ylabel("y")
plt.title("Discrete Chain vs Continuous Catenary")
plt.grid(True)
plt.legend()
plt.axis('equal')

plt.show()